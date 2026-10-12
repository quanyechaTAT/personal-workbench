import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { join } from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { DEFAULT_SANDBOX_POLICY, type RuntimeSandboxPolicy } from "@earendil-works/workbench-runtime";
import { Type } from "typebox";
import { sandboxCommand } from "./execution-sandbox.ts";
import { type TerminalResult, TerminalSessions } from "./terminal-sessions.ts";

const SHELL_SCRIPT = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
$shell = [PowerShell]::Create()
$initialized = $false
try {
  while ($null -ne ($line = [Console]::ReadLine())) {
    $request = ConvertFrom-Json -InputObject $line
    try {
      if (-not $initialized) {
        $directory = $request.cwd.Replace("'", "''")
        $shell.AddScript("Set-Location -LiteralPath '$directory'").Invoke() | Out-Null
        $shell.Commands.Clear()
        $initialized = $true
      }
      $shell.Streams.Error.Clear()
      $shell.Runspace.SessionStateProxy.SetVariable('LASTEXITCODE', 0)
      $output = $shell.AddScript($request.command, $false).Invoke()
      $text = ($output | Out-String -Width 256)
      $errors = ($shell.Streams.Error | Out-String -Width 256)
      $exitCode = $shell.Runspace.SessionStateProxy.GetVariable('LASTEXITCODE')
      $failed = $shell.HadErrors -or ($null -ne $exitCode -and $exitCode -ne 0)
      $result = @{ output = ($text + $errors); isError = [bool]$failed; exitCode = $exitCode }
    } catch { $result = @{ output = $_.Exception.Message; isError = $true; exitCode = $null } }
    finally { $shell.Commands.Clear() }
    if ($result.output.Length -gt 64000) { $result.output = $result.output.Substring(0, 64000) + [Environment]::NewLine + '[output truncated]' }
    [Console]::WriteLine('WORKBENCH_SHELL:' + (ConvertTo-Json -InputObject $result -Compress))
  }
} finally { $shell.Dispose() }
`;

interface ShellResult {
	output: string;
	isError: boolean;
	exitCode: number | null;
}

export function createPersistentShell(
	cwd: string,
	environment: NodeJS.ProcessEnv,
	terminalSessions?: TerminalSessions,
	sandbox: RuntimeSandboxPolicy = DEFAULT_SANDBOX_POLICY,
) {
	const terminals = terminalSessions ?? new TerminalSessions(cwd, environment, sandbox);
	let child: ChildProcessWithoutNullStreams | undefined;
	let pending: { resolve(value: ShellResult): void; reject(error: Error): void } | undefined;
	let buffer = "";
	let closing: Promise<void> | undefined;
	const close = () => {
		const previous = child;
		child = undefined;
		buffer = "";
		pending?.reject(new Error("持久终端已中断；下次调用将重新创建终端状态。"));
		pending = undefined;
		if (!previous || previous.exitCode !== null) return closing ?? Promise.resolve();
		closing = new Promise<void>((resolve) => {
			previous.once("close", () => resolve());
			if (process.platform === "win32" && previous.pid) {
				const killer = spawn(
					join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"),
					["/F", "/T", "/PID", String(previous.pid)],
					{ windowsHide: true, stdio: "ignore" },
				);
				killer.once("error", () => previous.kill());
				killer.once("close", (code) => {
					if (code !== 0) previous.kill();
				});
			} else previous.kill();
		});
		return closing;
	};
	const parameters = Type.Object({
		action: Type.Optional(
			Type.Union([
				Type.Literal("command"),
				Type.Literal("exec"),
				Type.Literal("read"),
				Type.Literal("write"),
				Type.Literal("close"),
			]),
		),
		command: Type.Optional(Type.String({ minLength: 1, maxLength: 16_000 })),
		session_id: Type.Optional(Type.String({ minLength: 1 })),
		chars: Type.Optional(Type.String({ maxLength: 16_000 })),
		yield_time_ms: Type.Optional(Type.Integer({ minimum: 0, maximum: 10_000 })),
		max_output_chars: Type.Optional(Type.Integer({ minimum: 1, maximum: 64_000 })),
		timeout: Type.Optional(Type.Integer({ minimum: 1, maximum: 300 })),
	});
	const tool = {
		name: "persistent_shell",
		label: "持久终端",
		executionMode: "sequential",
		description:
			"Execute PowerShell. Default action=command retains variables, functions and cwd for short commands. For dev servers and long or interactive commands always use action=exec: it returns promptly with a session_id. Then use action=read to poll new output, action=write with chars to send input (\\r submits, \\u0003 sends Ctrl+C), and action=close to terminate its process tree. Commands and inputs obey permissions; read needs no new approval. Stop closes terminals. Do not read credentials or bypass repository restrictions. Preserve actual exit status.",
		parameters,
		execute: async (_id, input, signal) => {
			signal?.throwIfAborted();
			if (input.action && input.action !== "command") {
				let details: TerminalResult;
				if (input.action === "exec") {
					if (!input.command) throw new Error("exec 需要 command");
					details = await terminals.start(input.command, input.yield_time_ms, input.max_output_chars, signal);
				} else {
					if (!input.session_id) throw new Error("续读、输入或关闭终端需要 session_id");
					if (input.action === "read" && input.chars) throw new Error("read 不接受输入，请使用 write");
					details =
						input.action === "close"
							? await terminals.close(input.session_id)
							: await terminals.read(
									input.session_id,
									input.action === "write" ? input.chars : "",
									input.yield_time_ms,
									input.max_output_chars,
									signal,
								);
				}
				return { content: [{ type: "text" as const, text: JSON.stringify(details) }], details };
			}
			if (!input.command) throw new Error("执行终端命令需要 command");
			await closing;
			signal?.throwIfAborted();
			if (pending) throw new Error("持久终端正在执行命令");
			if (!child) {
				const launch = sandboxCommand(
					cwd,
					"powershell.exe",
					[
						"-NoLogo",
						"-NoProfile",
						"-NonInteractive",
						"-EncodedCommand",
						Buffer.from(SHELL_SCRIPT, "utf16le").toString("base64"),
					],
					sandbox,
				);
				child = spawn(launch.executable, launch.args, { cwd, env: environment, windowsHide: true, stdio: "pipe" });
				const shellProcess = child;
				shellProcess.stdout.setEncoding("utf8");
				shellProcess.stdout.on("data", (chunk: string) => {
					if (child !== shellProcess) return;
					buffer += chunk;
					if (buffer.length > 1024 * 1024) {
						void close();
						return;
					}
					let end = buffer.indexOf("\n");
					while (end >= 0) {
						const line = buffer.slice(0, end).trim();
						buffer = buffer.slice(end + 1);
						if (line.startsWith("WORKBENCH_SHELL:")) {
							try {
								const result: unknown = JSON.parse(line.slice("WORKBENCH_SHELL:".length));
								if (
									typeof result !== "object" ||
									result === null ||
									!("output" in result) ||
									typeof result.output !== "string" ||
									!("isError" in result) ||
									typeof result.isError !== "boolean" ||
									!("exitCode" in result) ||
									(result.exitCode !== null && typeof result.exitCode !== "number")
								)
									throw new Error("Invalid shell response");
								pending?.resolve({ output: result.output, isError: result.isError, exitCode: result.exitCode });
								pending = undefined;
							} catch {
								void close();
							}
						}
						end = buffer.indexOf("\n");
					}
				});
				let diagnostic = "";
				shellProcess.stderr.on("data", (chunk: Buffer) => {
					diagnostic = (diagnostic + chunk.toString()).slice(-4_000);
				});
				shellProcess.on("error", (error) => {
					if (child !== shellProcess) return;
					pending?.reject(error);
					void close();
				});
				shellProcess.on("close", () => {
					if (child !== shellProcess) return;
					pending?.reject(new Error(diagnostic || "持久终端已退出"));
					pending = undefined;
					child = undefined;
				});
			}
			const abort = () => {
				void close();
			};
			const timeout = setTimeout(abort, (input.timeout ?? 120) * 1_000);
			signal?.addEventListener("abort", abort, { once: true });
			try {
				const result = await new Promise<ShellResult>((resolve, reject) => {
					pending = { resolve, reject };
					child!.stdin.write(`${JSON.stringify({ cwd, command: input.command })}\n`, (error) => {
						if (error) {
							reject(error);
							void close();
						}
					});
				});
				if (result.isError) throw new Error(result.output || `PowerShell exited with code ${result.exitCode}`);
				return {
					content: [{ type: "text" as const, text: result.output || "(no output)" }],
					details: { exitCode: result.exitCode },
				};
			} finally {
				clearTimeout(timeout);
				signal?.removeEventListener("abort", abort);
				await closing;
			}
		},
	} satisfies ToolDefinition<typeof parameters, { exitCode: number | null } | TerminalResult, unknown>;
	return {
		tool,
		close: async () => {
			await close();
			if (!terminalSessions) await terminals.dispose();
		},
	};
}
