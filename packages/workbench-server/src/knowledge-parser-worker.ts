import { parentPort, workerData } from "node:worker_threads";
import { WorkbenchError } from "@earendil-works/workbench-core";
import { parseKnowledgeDocument } from "./knowledge-document-parser.ts";

const input = workerData as { path: string; name: string; allowScanned?: boolean };
try {
	const parsed = await parseKnowledgeDocument(input.path, input.name, undefined, input.allowScanned);
	parentPort?.postMessage({ parsed });
} catch (error) {
	parentPort?.postMessage({
		error: error instanceof WorkbenchError ? error.message : "文档解析失败，请检查文件格式或内容",
	});
}
