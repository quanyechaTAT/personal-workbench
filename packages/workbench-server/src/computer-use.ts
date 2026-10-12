import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { WorkbenchError } from "@earendil-works/workbench-core";
import {
	type ComputerUseInput,
	ComputerUseSchema,
	type InteractionResult,
} from "@earendil-works/workbench-core/contracts";
import { Type } from "typebox";
import { Parse } from "typebox/value";
import { COMPUTER_USE_SCRIPT } from "./computer-use-script.ts";

const Rect = Type.Object({ x: Type.Integer(), y: Type.Integer(), width: Type.Integer(), height: Type.Integer() });
const NativeResult = Type.Object({
	action: Type.String(),
	screen: Rect,
	cursor: Type.Object({ x: Type.Integer(), y: Type.Integer() }),
	foregroundWindowId: Type.String(),
	capture: Type.Optional(Rect),
	image: Type.Optional(Type.String()),
	windows: Type.Optional(
		Type.Array(
			Type.Object({
				id: Type.String(),
				title: Type.String(),
				processId: Type.Integer(),
				x: Type.Integer(),
				y: Type.Integer(),
				width: Type.Integer(),
				height: Type.Integer(),
			}),
		),
	),
});

export class ComputerUseService {
	private readonly scriptPath: string;
	private ready?: Promise<void>;
	private queue = Promise.resolve();
	private disposed = false;
	constructor(cacheRoot: string) {
		this.scriptPath = join(
			resolve(cacheRoot),
			`computer-use-${createHash("sha256").update(COMPUTER_USE_SCRIPT).digest("hex").slice(0, 16)}.ps1`,
		);
	}
	async execute(_sessionId: string, input: ComputerUseInput, signal?: AbortSignal): Promise<InteractionResult> {
		let parsed: ComputerUseInput;
		try {
			parsed = Parse(ComputerUseSchema, input);
		} catch {
			throw new WorkbenchError("invalid_input", "桌面工具参数无效");
		}
		const operation = this.queue.then(() => this.perform(parsed, signal));
		this.queue = operation.then(
			() => undefined,
			() => undefined,
		);
		return operation;
	}
	private async perform(input: ComputerUseInput, signal?: AbortSignal): Promise<InteractionResult> {
		signal?.throwIfAborted();
		if (this.disposed) throw new WorkbenchError("conflict", "桌面工具已关闭");
		if (process.platform !== "win32") throw new WorkbenchError("invalid_input", "桌面工具目前支持 Windows");
		this.ready ??= mkdir(dirname(this.scriptPath), { recursive: true }).then(() =>
			writeFile(this.scriptPath, `\uFEFF${COMPUTER_USE_SCRIPT}`, "utf8"),
		);
		await this.ready;
		signal?.throwIfAborted();
		const stdout = await new Promise<string>((resolveResult, reject) => {
			const child = execFile(
				join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
				["-NoProfile", "-NonInteractive", "-Sta", "-File", this.scriptPath],
				{ windowsHide: true, signal, timeout: 20_000, maxBuffer: 32 * 1024 * 1024, encoding: "utf8" },
				(error, output, stderr) => {
					if (error) {
						reject(
							new WorkbenchError(
								signal?.aborted ? "conflict" : "external_failure",
								signal?.aborted
									? "桌面操作已停止"
									: `桌面操作失败：${stderr.trim().slice(0, 1500) || error.message}`,
								{ cause: error },
							),
						);
					} else resolveResult(output);
				},
			);
			child.stdin?.on("error", () => undefined);
			child.stdin?.end(JSON.stringify(input));
		});
		signal?.throwIfAborted();
		const native = Parse(NativeResult, JSON.parse(stdout) as unknown);
		const { image, ...details } = native;
		const result: InteractionResult = { content: [{ type: "text", text: JSON.stringify(details) }], details };
		if (image) result.content.push({ type: "image", mimeType: "image/png", data: image });
		return result;
	}
	async dispose(): Promise<void> {
		this.disposed = true;
		await this.queue;
	}
}
