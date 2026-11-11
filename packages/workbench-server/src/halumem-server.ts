import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { WorkbenchError } from "@earendil-works/workbench-core";
import { Parse } from "typebox/value";
import {
	HaluMemAddSchema,
	HaluMemGetSchema,
	HaluMemQuotaExhausted,
	HaluMemRetrieveSchema,
	type HaluMemService,
} from "./halumem-service.ts";

/** Optional, separately launched evaluation host. The normal Workbench server does not expose these routes. */
export class HaluMemServer {
	private readonly server: Server;
	private readonly service: HaluMemService;
	private readonly token: string;
	private readonly pending = new Set<Promise<void>>();
	private port = 0;
	constructor(service: HaluMemService, token: string) {
		if (token.length < 16) throw new Error("HALUMEM_API_TOKEN must contain at least 16 characters");
		this.service = service;
		this.token = token;
		this.server = createServer((request, response) => {
			const pending = this.handle(request, response);
			this.pending.add(pending);
			void pending.finally(() => this.pending.delete(pending));
		});
	}
	async start(port = 4243): Promise<string> {
		await new Promise<void>((resolve, reject) => {
			this.server.once("error", reject);
			this.server.listen(port, "127.0.0.1", () => {
				this.server.off("error", reject);
				resolve();
			});
		});
		const address = this.server.address();
		if (!address || typeof address === "string") throw new Error("Evaluation server did not bind TCP");
		this.port = address.port;
		return `http://127.0.0.1:${address.port}`;
	}
	async close(): Promise<void> {
		const closed = new Promise<void>((resolve, reject) =>
			this.server.close((error) => (error ? reject(error) : resolve())),
		);
		this.server.closeAllConnections();
		await this.service.close();
		await Promise.all(this.pending);
		await closed;
	}
	private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
		const controller = new AbortController();
		const abort = () => controller.abort();
		response.once("close", abort);
		try {
			if (![`127.0.0.1:${this.port}`, `localhost:${this.port}`].includes(request.headers.host ?? ""))
				throw new WorkbenchError("path_denied", "Invalid evaluation Host");
			if (request.headers.origin && request.headers.origin !== `http://${request.headers.host}`)
				throw new WorkbenchError("path_denied", "Cross-origin evaluation request denied");
			if (request.headers.authorization !== `Bearer ${this.token}`)
				throw new WorkbenchError("path_denied", "Invalid evaluation token");
			const url = new URL(request.url ?? "/", "http://localhost");
			let value: unknown;
			if (request.method === "GET" && url.pathname === "/health") {
				this.service.assertModelQuota();
				value = { status: "ok", model: this.service.model, protocol: "halumem-v1" };
			} else if (request.method === "GET" && url.pathname === "/get-dialogue-memory")
				value = await this.service.getDialogueMemory(Parse(HaluMemGetSchema, Object.fromEntries(url.searchParams)));
			else if (request.method === "POST" && url.pathname === "/add-dialogue")
				value = await this.service.addDialogue(
					Parse(HaluMemAddSchema, await this.body(request)),
					controller.signal,
				);
			else if (request.method === "POST" && url.pathname === "/retrieve-memory")
				value = await this.service.retrieveMemory(
					Parse(HaluMemRetrieveSchema, await this.body(request)),
					controller.signal,
				);
			else throw new WorkbenchError("not_found", "Unknown HaluMem API");
			this.send(response, 200, value);
		} catch (error) {
			if (error instanceof HaluMemQuotaExhausted) {
				this.send(response, 402, { error: { code: "quota_exhausted", message: error.message } });
				return;
			}
			const code = error instanceof WorkbenchError ? error.code : "invalid_input";
			const status =
				code === "path_denied"
					? 403
					: code === "not_found"
						? 404
						: code === "conflict"
							? 409
							: code === "external_failure"
								? 502
								: 400;
			this.send(response, status, {
				error: {
					code,
					message:
						error instanceof WorkbenchError
							? error.message
							: "Invalid evaluation request or unavailable evaluation workspace",
				},
			});
		} finally {
			response.off("close", abort);
		}
	}
	private send(response: ServerResponse, status: number, value: unknown): void {
		if (response.destroyed) return;
		response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
		response.end(JSON.stringify(value));
	}
	private async body(request: IncomingMessage): Promise<unknown> {
		const chunks: Buffer[] = [];
		let size = 0;
		for await (const chunk of request) {
			const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
			size += bytes.length;
			if (size > 16 * 1024 * 1024) throw new WorkbenchError("invalid_input", "Dialogue request exceeds 16 MiB");
			chunks.push(bytes);
		}
		return JSON.parse(Buffer.concat(chunks).toString("utf8"));
	}
}
