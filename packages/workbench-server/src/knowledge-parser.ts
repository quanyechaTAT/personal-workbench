import { Worker } from "node:worker_threads";
import { WorkbenchError } from "@earendil-works/workbench-core";
import type { ParsedDocument } from "./knowledge-document-parser.ts";

/** Parsing cannot block the Gateway or consume its process heap indefinitely. */
export async function parseDocumentInWorker(
	path: string,
	name: string,
	signal?: AbortSignal,
	allowScanned = false,
): Promise<ParsedDocument> {
	signal?.throwIfAborted();
	const worker = new Worker(
		new URL(
			import.meta.url.endsWith(".ts") ? "./knowledge-parser-worker.ts" : "./knowledge-parser-worker.js",
			import.meta.url,
		),
		{ workerData: { path, name, allowScanned }, execArgv: [], resourceLimits: { maxOldGenerationSizeMb: 256 } },
	);
	try {
		return await new Promise<ParsedDocument>((resolve, reject) => {
			const aborted = () => reject(new WorkbenchError("conflict", "文档处理已取消"));
			const timer = setTimeout(
				() => reject(new WorkbenchError("invalid_input", "文档解析超过 60 秒，请拆分或检查文件")),
				60_000,
			);
			const clean = () => {
				clearTimeout(timer);
				signal?.removeEventListener("abort", aborted);
			};
			signal?.addEventListener("abort", aborted, { once: true });
			worker.once("message", (message: { parsed?: ParsedDocument; error?: string }) => {
				clean();
				if (message.parsed) resolve(message.parsed);
				else reject(new WorkbenchError("invalid_input", message.error ?? "文档解析失败"));
			});
			worker.once("error", () => {
				clean();
				reject(new WorkbenchError("invalid_input", "文档解析进程失败或超出内存上限，请检查文件"));
			});
			worker.once("exit", () => {
				clean();
				reject(new WorkbenchError("invalid_input", "文档解析进程未返回正文"));
			});
		});
	} finally {
		await worker.terminate();
	}
}
