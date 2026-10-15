import { spawn as spawnProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { getShellConfig, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { DEFAULT_SANDBOX_POLICY, type RuntimeSandboxPolicy } from "@earendil-works/workbench-runtime";
import { type IDisposable, type IPty, spawn as spawnPty } from "node-pty";
import { Type } from "typebox";
import { sandboxCommand } from "./execution-sandbox.ts";

const MAX_BUFFER = 512 * 1024;
const MAX_ACTIVE = 8;
const MAX_RETAINED = 32;

export interface TerminalResult {
	session_id: string;
	status: "running" | "exited" | "closed";
	exit_code: number | null;
	output: string;
	more_output: boolean;
	truncated: boolean;
}

interface TerminalSession {
	id: string;
	pty: IPty;
	buffer: string;
	dropped: boolean;
	exitCode: number | null;
	closed: boolean;
	polling: boolean;
	waiters: Set<() => void>;
	subscriptions: IDisposable[];
	closing?: Promise<void>;
}

export class TerminalSessions {
	private readonly cwd: string;
	private readonly environment: NodeJS.ProcessEnv;
	private readonly sandbox: RuntimeSandboxPolicy;
	private readonly sessions = new Map<string, TerminalSession>();
	private disposed = false;

	constructor(cwd: string, environment: NodeJS.ProcessEnv, sandbox: RuntimeSandboxPolicy = DEFAULT_SANDBOX_POLICY) {
		this.cwd = cwd;
		this.environment = environment;
		this.sandbox = structuredClone(sandbox);
	}

	async start(
		command: string,
		yieldMs = 1000,
		maxOutput = 16_000,
		signal?: AbortSignal,
		shell?: "powershell" | "bash",
	): Promise<TerminalResult> {
		signal?.throwIfAborted();
		if (this.disposed) throw new Error("终端管理器已关闭");
		if (!command.trim()) throw new Error("终端命令不能为空");
		if (
			[...this.sessions.values()].filter((session) => session.exitCode === null && !session.closed).length >=
			MAX_ACTIVE
		)
			throw new Error("当前对话最多同时运行 8 个终端，请先关闭不再使用的终端");
		for (const [id, session] of this.sessions) {
			if (this.sessions.size < MAX_RETAINED) break;
			if (session.exitCode !== null || session.closed) {
				for (const subscription of session.subscriptions) subscription.dispose();
				this.sessions.delete(id);
			}
		}
		const windows = process.platform === "win32";
		const bash = shell === "bash" || (!windows && shell !== "powershell") ? getShellConfig() : undefined;
		if (windows && bash?.commandTransport === "stdin" && this.sandbox.mode !== "danger-full-access")
			throw new Error("Windows 原生沙箱不能隔离 WSL 命令；请使用 Git Bash，或在 WSL 中运行工作台。");
		const script = `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8\n[Console]::InputEncoding = [System.Text.Encoding]::UTF8\n$OutputEncoding = [System.Text.Encoding]::UTF8\n$ErrorActionPreference = 'Stop'\n$global:LASTEXITCODE = 0\ntry { & {\n${command}\n}; exit ([int]$global:LASTEXITCODE) } catch { Write-Error $_ -ErrorAction Continue; exit 1 }`;
		const launch = sandboxCommand(
			this.cwd,
			bash?.shell ?? "powershell.exe",
			bash
				? bash.commandTransport === "stdin"
					? bash.args
					: [...bash.args, command]
				: windows
					? ["-NoLogo", "-NoProfile", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")]
					: ["-c", command],
			this.sandbox,
		);
		const pty = spawnPty(launch.executable, launch.args, {
			cwd: this.cwd,
			env: this.environment,
			name: "xterm-256color",
			cols: 160,
			rows: 40,
			...(windows ? {} : { encoding: "utf8" }),
			useConpty: true,
			conptyInheritCursor: false,
		});
		const session: TerminalSession = {
			id: randomUUID(),
			pty,
			buffer: "",
			dropped: false,
			exitCode: null,
			closed: false,
			polling: false,
			waiters: new Set(),
			subscriptions: [],
		};
		this.sessions.set(session.id, session);
		if (process.env.WORKBENCH_DEBUG_TERMINAL === "1") console.error("[DEBUG-pty-start]", pty.pid, command);
		session.subscriptions.push(
			pty.onData((data) => {
				if (process.env.WORKBENCH_DEBUG_TERMINAL === "1")
					console.error("[DEBUG-pty-data]", pty.pid, JSON.stringify(data));
				session.buffer += stripVTControlCharacters(data).replaceAll("\r\n", "\n");
				if (session.buffer.length > MAX_BUFFER) {
					session.buffer = session.buffer.slice(-MAX_BUFFER);
					session.dropped = true;
				}
			}),
		);
		session.subscriptions.push(
			pty.onExit(({ exitCode }) => {
				if (process.env.WORKBENCH_DEBUG_TERMINAL === "1") console.error("[DEBUG-pty-exit]", pty.pid, exitCode);
				session.exitCode = exitCode;
				for (const resolve of session.waiters) resolve();
				for (const subscription of session.subscriptions) subscription.dispose();
			}),
		);
		if (bash?.commandTransport === "stdin") pty.write(`${command.replaceAll("\r\n", "\n")}\nexit $?\n`);
		return this.read(session.id, "", yieldMs, maxOutput, signal);
	}

	async read(
		id: string,
		chars = "",
		yieldMs = 1000,
		maxOutput = 16_000,
		signal?: AbortSignal,
	): Promise<TerminalResult> {
		signal?.throwIfAborted();
		const session = this.requireSession(id);
		if (session.polling) throw new Error("同一个终端不能同时续读或输入，请等待当前调用返回");
		if (chars && (session.closed || session.exitCode !== null)) throw new Error("终端已退出，不能继续输入");
		session.polling = true;
		const onAbort = () => {
			void this.close(id).catch((error: unknown) => {
				session.buffer += `\n终端清理失败：${error instanceof Error ? error.message : String(error)}`;
			});
		};
		signal?.addEventListener("abort", onAbort, { once: true });
		try {
			if (chars) session.pty.write(chars);
			if (!session.closed && session.exitCode === null && yieldMs > 0) {
				await new Promise<void>((resolve) => {
					const finish = () => {
						clearTimeout(timer);
						session.waiters.delete(finish);
						resolve();
					};
					const timer = setTimeout(finish, Math.min(10_000, Math.max(0, yieldMs)));
					session.waiters.add(finish);
				});
			}
			signal?.throwIfAborted();
			const limit = Math.min(64_000, Math.max(1, maxOutput));
			const result: TerminalResult = {
				session_id: id,
				status: session.closed ? "closed" : session.exitCode === null ? "running" : "exited",
				exit_code: session.exitCode,
				output: session.buffer.slice(0, limit),
				more_output: session.buffer.length > limit,
				truncated: session.dropped,
			};
			session.buffer = session.buffer.slice(limit);
			session.dropped = false;
			return result;
		} finally {
			session.polling = false;
			signal?.removeEventListener("abort", onAbort);
		}
	}

	async close(id: string): Promise<TerminalResult> {
		const session = this.requireSession(id);
		if (!session.closing) {
			session.closed = true;
			for (const resolve of session.waiters) resolve();
			session.closing = (async () => {
				if (session.exitCode === null) {
					if (process.platform === "win32") {
						await new Promise<void>((resolve, reject) => {
							const killer = spawnProcess(
								join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"),
								["/F", "/T", "/PID", String(session.pty.pid)],
								{ windowsHide: true, stdio: "ignore" },
							);
							killer.once("error", reject);
							killer.once("close", (code) => {
								let alive = false;
								try {
									process.kill(session.pty.pid, 0);
									alive = true;
								} catch {
									/* Process has already exited. */
								}
								if (code !== 0 && alive) reject(new Error("无法关闭终端进程树"));
								else resolve();
							});
						});
					} else {
						try {
							process.kill(-session.pty.pid, "SIGKILL");
						} catch (error) {
							if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
						}
					}
					if (session.exitCode === null) {
						await new Promise<void>((resolve, reject) => {
							const timer = setTimeout(() => {
								subscription.dispose();
								reject(new Error("终端关闭后未返回退出状态"));
							}, 5000);
							const subscription = session.pty.onExit(() => {
								clearTimeout(timer);
								subscription.dispose();
								resolve();
							});
						});
					}
				}
				for (const subscription of session.subscriptions) subscription.dispose();
			})();
		}
		await session.closing;
		const result: TerminalResult = {
			session_id: id,
			status: "closed",
			exit_code: session.exitCode,
			output: session.buffer.slice(0, 64_000),
			more_output: session.buffer.length > 64_000,
			truncated: session.dropped,
		};
		session.buffer = session.buffer.slice(64_000);
		session.dropped = false;
		return result;
	}

	async closeAll(): Promise<void> {
		const results = await Promise.allSettled([...this.sessions.keys()].map((id) => this.close(id)));
		this.sessions.clear();
		const failures = results.filter((result) => result.status === "rejected");
		if (failures.length)
			throw new AggregateError(
				failures.map((result) => result.reason),
				"部分终端未能关闭",
			);
	}

	async dispose(): Promise<void> {
		this.disposed = true;
		await this.closeAll();
	}

	private requireSession(id: string): TerminalSession {
		const session = this.sessions.get(id);
		if (!session) throw new Error("终端会话不存在或不属于当前对话，请重新启动命令");
		return session;
	}
}

const pollProperties = {
	yield_time_ms: Type.Optional(Type.Integer({ minimum: 0, maximum: 10_000 })),
	max_output_chars: Type.Optional(Type.Integer({ minimum: 1, maximum: 64_000 })),
};

export function createTerminalTools(terminals: TerminalSessions): ToolDefinition[] {
	const executeParameters = Type.Object({
		command: Type.String({ minLength: 1, maxLength: 16_000 }),
		...pollProperties,
	});
	const writeParameters = Type.Object({
		session_id: Type.String({ minLength: 1 }),
		chars: Type.Optional(Type.String({ maxLength: 16_000 })),
		...pollProperties,
	});
	const closeParameters = Type.Object({ session_id: Type.String({ minLength: 1 }) });
	const result = (details: TerminalResult) => ({
		content: [{ type: "text" as const, text: JSON.stringify(details) }],
		details,
	});
	return [
		{
			name: "exec_command",
			label: "启动终端命令",
			executionMode: "sequential",
			description:
				"Execute a command in a real PTY (PowerShell on Windows). Returns within yield_time_ms (default 1000, max 10000) with session_id, running/exited status, incremental output and actual exit_code. Use for dev servers, interactive programs and long commands. A running process continues across tools and turns. Continue with write_stdin, then close_terminal when done. Obeys shell approval; Stop closes this conversation's terminals.",
			parameters: executeParameters,
			execute: async (_id, input, signal) =>
				result(await terminals.start(input.command, input.yield_time_ms, input.max_output_chars, signal)),
		} satisfies ToolDefinition<typeof executeParameters, TerminalResult, unknown>,
		{
			name: "write_stdin",
			label: "续读与输入终端",
			executionMode: "sequential",
			description:
				"Continue a terminal session belonging to this conversation. Omit chars to read only new output without another approval; provide chars to send interactive input (requires shell approval). Use \\r to submit a line and \\u0003 for Ctrl+C. Bounded yield_time_ms returns promptly; more_output indicates unread buffered output. Do not repeat commands to poll.",
			parameters: writeParameters,
			execute: async (_id, input, signal) =>
				result(
					await terminals.read(input.session_id, input.chars, input.yield_time_ms, input.max_output_chars, signal),
				),
		} satisfies ToolDefinition<typeof writeParameters, TerminalResult, unknown>,
		{
			name: "close_terminal",
			label: "关闭终端",
			executionMode: "sequential",
			description:
				"Terminate this conversation's terminal and its process tree, including any dev server. Requires shell approval. Use when a running process is no longer needed.",
			parameters: closeParameters,
			execute: async (_id, input, signal) => {
				signal?.throwIfAborted();
				return result(await terminals.close(input.session_id));
			},
		} satisfies ToolDefinition<typeof closeParameters, TerminalResult, unknown>,
	];
}
