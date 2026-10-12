import type { IncomingMessage, ServerResponse } from "node:http";
import { type Project, WorkbenchError } from "@earendil-works/workbench-core";
import { MAX_DOCUMENT_BYTES } from "./knowledge-document-parser.ts";
import type { KnowledgeService } from "./knowledge-service.ts";

export async function handleKnowledgeRequest(
	service: KnowledgeService,
	project: Project,
	request: IncomingMessage,
	response: ServerResponse,
	url: URL,
	route: string[],
	send: (response: ServerResponse, status: number, value: unknown) => void,
): Promise<void> {
	const method = request.method ?? "GET";
	if (method === "GET" && route.length === 0) return send(response, 200, await service.status(project));
	if (method === "GET" && route.length === 1 && ["search", "retrieve"].includes(route[0])) {
		const limit = Number(url.searchParams.get("limit") ?? 6);
		if (!Number.isInteger(limit) || limit < 1 || limit > 20)
			throw new WorkbenchError("invalid_input", "检索结果上限必须是 1 到 20 的整数");
		const controller = new AbortController();
		const abort = () => controller.abort();
		response.once("close", abort);
		try {
			const result = await service.retrieve(project, url.searchParams.get("q") ?? "", limit, controller.signal);
			return send(response, 200, route[0] === "search" ? result.hits : result);
		} finally {
			response.off("close", abort);
		}
	}
	if (method === "PUT" && route.length === 1 && route[0] === "settings") {
		let body = "";
		for await (const chunk of request) {
			body += chunk.toString();
			if (Buffer.byteLength(body) > 8192) throw new WorkbenchError("invalid_input", "知识库参数超过大小上限");
		}
		let value: unknown;
		try {
			value = JSON.parse(body);
		} catch {
			throw new WorkbenchError("invalid_input", "知识库参数不是有效 JSON");
		}
		return send(response, 200, await service.configure(project, value));
	}
	if (method === "POST" && route.length === 1 && route[0] === "index") {
		const controller = new AbortController();
		const abort = () => controller.abort();
		response.once("close", abort);
		try {
			return send(response, 200, await service.index(project, controller.signal));
		} finally {
			response.off("close", abort);
		}
	}
	if (method === "POST" && route.length === 1 && route[0] === "snapshot")
		return send(response, 202, await service.snapshot(project, url.searchParams.get("path") ?? ""));
	if (route[0] !== "documents") throw new WorkbenchError("not_found", "知识库接口不存在");
	if (method === "GET" && route.length === 1) return send(response, 200, await service.listDocuments(project));
	if (method === "POST" && route.length === 1) {
		const declared = Number(request.headers["content-length"] ?? 0);
		if (declared > MAX_DOCUMENT_BYTES) {
			request.resume();
			throw new WorkbenchError("invalid_input", "上传文档超过 20 MiB");
		}
		const name = url.searchParams.get("name") ?? "";
		const buffers: Buffer[] = [];
		let size = 0;
		for await (const chunk of request) {
			const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
			size += buffer.length;
			if (size > MAX_DOCUMENT_BYTES) throw new WorkbenchError("invalid_input", "上传文档超过 20 MiB");
			buffers.push(buffer);
		}
		return send(response, 202, await service.upload(project, name, Buffer.concat(buffers)));
	}
	if (route.length === 3 && route[2] === "preview" && method === "GET")
		return send(response, 200, await service.preview(project, route[1]));
	if (route.length === 3 && route[2] === "confirm-description" && method === "POST")
		return send(
			response,
			200,
			await service.confirmDescription(project, route[1], url.searchParams.get("fingerprint") ?? ""),
		);
	if (route.length === 3 && route[2] === "captions" && method === "GET") {
		const bytes = Buffer.from(await service.captions(project, route[1]));
		response.writeHead(200, {
			"content-type": "text/vtt; charset=utf-8",
			"content-length": bytes.length,
			"cache-control": "no-store",
			"x-content-type-options": "nosniff",
		});
		response.end(bytes);
		return;
	}
	if (route.length === 3 && route[2] === "retry" && method === "POST")
		return send(
			response,
			202,
			await service.retryDocument(
				project,
				route[1],
				url.searchParams.has("describeScans") ? url.searchParams.get("describeScans") === "true" : undefined,
			),
		);
	if (route.length === 3 && route[2] === "cancel" && method === "POST")
		return send(response, 200, await service.cancelDocument(project, route[1]));
	if (route.length === 3 && ["markdown", "sources"].includes(route[2]) && method === "GET") {
		const { document, derived } = await service.preview(project, route[1]);
		if (!derived) throw new WorkbenchError("not_found", "Markdown 派生内容尚未生成");
		const markdown = route[2] === "markdown";
		const bytes = Buffer.from(
			markdown ? derived.markdown : JSON.stringify({ ...derived, markdown: undefined }, null, 2),
		);
		response.writeHead(200, {
			"content-type": markdown ? "text/markdown; charset=utf-8" : "application/json; charset=utf-8",
			"content-length": bytes.length,
			"content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(`${document.name}.${markdown ? "md" : "sources.json"}`)}`,
			"cache-control": "no-store",
			"x-content-type-options": "nosniff",
		});
		response.end(bytes);
		return;
	}
	if (route.length === 2 && method === "DELETE") {
		await service.deleteDocument(project, route[1]);
		return send(response, 200, { deleted: true });
	}
	if (route.length === 3 && route[2] === "index" && method === "DELETE") {
		await service.deleteIndex(project, route[1]);
		return send(response, 200, { deleted: true, originalRetained: true });
	}
	if (route.length === 3 && route[2] === "page" && method === "GET") {
		const bytes = await service.pageImage(project, route[1], Number(url.searchParams.get("page")));
		response.writeHead(200, {
			"content-type": "image/png",
			"content-length": bytes.length,
			"cache-control": "no-store",
			"x-content-type-options": "nosniff",
			"content-security-policy": "default-src 'none'; frame-ancestors 'none'",
		});
		response.end(bytes);
		return;
	}
	if (route.length === 3 && ["file", "view"].includes(route[2]) && method === "GET") {
		const { document, bytes } = await service.original(project, route[1]);
		const inline = route[2] === "view";
		if (
			inline &&
			!["image/png", "image/jpeg", "image/bmp", "application/pdf", "audio/wav", "audio/mpeg"].includes(
				document.mimeType,
			)
		)
			throw new WorkbenchError("invalid_input", "此格式仅支持下载原件");
		response.writeHead(200, {
			"content-type": document.mimeType,
			"content-length": bytes.length,
			"content-disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(document.name)}`,
			"cache-control": "no-store",
			"x-content-type-options": "nosniff",
			"content-security-policy": "default-src 'none'; frame-ancestors 'self'",
		});
		response.end(bytes);
		return;
	}
	throw new WorkbenchError("not_found", "知识文档接口不存在");
}
