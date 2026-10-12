import { createServer, type ServerResponse } from "node:http";
import { zstdDecompressSync } from "node:zlib";

export interface CapturedModelRequest {
	path: string;
	body: Record<string, unknown>;
	authorization?: string;
	apiKey?: string;
}

/** A local protocol server: Pi still serializes requests and parses actual streamed responses. */
export async function startModelServer(
	options: {
		catalog?: unknown;
		holdCatalog?: boolean;
		onCatalog?(): void;
		modelError?: { status: number; message: string };
	} = {},
) {
	const requests: CapturedModelRequest[] = [];
	const catalogRequests: Array<{ path: string; authorization?: string; apiKey?: string }> = [];
	let cancelledCatalogRequests = 0;
	const server = createServer(async (request, response) => {
		try {
			const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
			if (request.method === "GET" && pathname.endsWith("/models")) {
				catalogRequests.push({
					path: request.url ?? "",
					authorization: request.headers.authorization,
					apiKey: typeof request.headers["x-api-key"] === "string" ? request.headers["x-api-key"] : undefined,
				});
				response.once("close", () => {
					if (!response.writableFinished) cancelledCatalogRequests++;
				});
				options.onCatalog?.();
				if (options.holdCatalog) return;
				response.writeHead(200, { "content-type": "application/json" });
				response.end(
					JSON.stringify(
						options.catalog ?? {
							data: [
								{
									id: "deepseek-flash",
									name: "DeepSeek Flash",
									context_window: 32768,
									max_output_tokens: 1024,
									input_modalities: ["text"],
									effort: { supported_levels: ["none", "low", "high", "max"] },
								},
								{ id: "not-selected" },
							],
						},
					),
				);
				return;
			}
			const chunks: Buffer[] = [];
			for await (const chunk of request) chunks.push(Buffer.from(chunk));
			const bytes = Buffer.concat(chunks);
			const body: unknown = JSON.parse(
				(request.headers["content-encoding"] === "zstd" ? zstdDecompressSync(bytes) : bytes).toString("utf8"),
			);
			if (typeof body !== "object" || body === null || Array.isArray(body)) throw new Error("Invalid request");
			requests.push({
				path: request.url ?? "",
				body: body as Record<string, unknown>,
				authorization: request.headers.authorization,
				apiKey: typeof request.headers["x-api-key"] === "string" ? request.headers["x-api-key"] : undefined,
			});
			if (options.modelError) {
				response.writeHead(options.modelError.status, { "content-type": "application/json" });
				response.end(JSON.stringify({ error: { message: options.modelError.message, code: "daily_quota" } }));
				return;
			}
			response.writeHead(200, { "content-type": "text/event-stream" });
			if (pathname.endsWith("/chat/completions")) completions(response);
			else if (pathname.endsWith("/messages")) messages(response);
			else if (pathname.endsWith("/responses")) responses(response);
			else throw new Error(`Unexpected endpoint ${request.url}`);
			response.end();
		} catch (error) {
			response.destroy(error instanceof Error ? error : new Error(String(error)));
		}
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("No test model address");
	return {
		origin: `http://127.0.0.1:${address.port}`,
		requests,
		catalogRequests,
		get cancelledCatalogRequests() {
			return cancelledCatalogRequests;
		},
		close: async () => {
			server.closeAllConnections();
			await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
		},
	};
}

function event(response: ServerResponse, type: string, body: Record<string, unknown>) {
	response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...body })}\n\n`);
}

function completions(response: ServerResponse) {
	for (const chunk of [
		{ choices: [{ index: 0, delta: { role: "assistant", content: "收到" }, finish_reason: null }] },
		{ choices: [{ index: 0, delta: { content: "消息" }, finish_reason: null }] },
		{
			choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
			usage: { prompt_tokens: 2, completion_tokens: 2, total_tokens: 4 },
		},
	])
		response.write(
			`data: ${JSON.stringify({ id: "wire-completions", object: "chat.completion.chunk", model: "deepseek-flash", created: 1, ...chunk })}\n\n`,
		);
	response.write("data: [DONE]\n\n");
}

function messages(response: ServerResponse) {
	event(response, "message_start", {
		message: {
			id: "wire-messages",
			type: "message",
			role: "assistant",
			model: "deepseek-flash",
			content: [],
			stop_reason: null,
			stop_sequence: null,
			usage: { input_tokens: 2, output_tokens: 0 },
		},
	});
	event(response, "content_block_start", { index: 0, content_block: { type: "text", text: "" } });
	event(response, "content_block_delta", { index: 0, delta: { type: "text_delta", text: "收到消息" } });
	event(response, "content_block_stop", { index: 0 });
	event(response, "message_delta", {
		delta: { stop_reason: "end_turn", stop_sequence: null },
		usage: { output_tokens: 2 },
	});
	event(response, "message_stop", {});
}

function responses(response: ServerResponse) {
	const item = {
		id: "wire-message",
		type: "message",
		status: "completed",
		role: "assistant",
		content: [{ type: "output_text", text: "收到消息", annotations: [] }],
	};
	const result = {
		id: "wire-response",
		object: "response",
		created_at: 1,
		model: "deepseek-flash",
		status: "in_progress",
		output: [],
	};
	event(response, "response.created", { response: result });
	event(response, "response.output_item.added", {
		output_index: 0,
		item: { ...item, status: "in_progress", content: [] },
	});
	event(response, "response.content_part.added", {
		item_id: item.id,
		output_index: 0,
		content_index: 0,
		part: { type: "output_text", text: "", annotations: [] },
	});
	event(response, "response.output_text.delta", {
		item_id: item.id,
		output_index: 0,
		content_index: 0,
		delta: "收到消息",
	});
	event(response, "response.output_text.done", {
		item_id: item.id,
		output_index: 0,
		content_index: 0,
		text: "收到消息",
	});
	event(response, "response.output_item.done", { output_index: 0, item });
	event(response, "response.completed", {
		response: {
			...result,
			status: "completed",
			output: [item],
			usage: { input_tokens: 2, output_tokens: 2, total_tokens: 4 },
		},
	});
}
