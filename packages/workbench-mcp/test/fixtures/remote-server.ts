import { createHash, randomUUID } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import {
	createMcpHandler,
	type JSONRPCMessage,
	parseJSONRPCMessage,
	Server,
	type Transport,
} from "@modelcontextprotocol/server";

class LegacySseTransport implements Transport {
	readonly id = randomUUID();
	onmessage?: Transport["onmessage"];
	onclose?: () => void;
	onerror?: (error: Error) => void;
	private readonly response: ServerResponse;
	constructor(response: ServerResponse) {
		this.response = response;
	}
	async start() {
		this.response.writeHead(200, {
			"content-type": "text/event-stream",
			"cache-control": "no-cache",
			connection: "keep-alive",
		});
		this.response.write(`event: endpoint\ndata: /messages?id=${this.id}\n\n`);
	}
	async send(message: JSONRPCMessage) {
		this.response.write(`event: message\ndata: ${JSON.stringify(message)}\n\n`);
	}
	async close() {
		this.response.end();
		this.onclose?.();
	}
}

/** Actual SDK server. OAuth endpoints are a local authorization-server fixture with PKCE verification. */
export async function startRemoteMcpFixture(options: { oauth?: boolean } = {}) {
	let description = "Echo test input";
	let calls = 0;
	let refreshes = 0;
	let exchanges = 0;
	let origin = "";
	let sequence = 0;
	const tokens = new Set<string>();
	const codes = new Map<string, { challenge: string; redirectUri: string }>();
	const legacy = new Map<string, { server: Server; transport: LegacySseTransport }>();
	function factory() {
		const server = new Server({ name: "workbench-http-fixture", version: "1.0.0" }, { capabilities: { tools: {} } });
		server.setRequestHandler("tools/list", async () => ({
			tools: [
				{
					name: "echo",
					description,
					inputSchema: {
						type: "object",
						properties: { text: { type: "string" } },
						required: ["text"],
						additionalProperties: false,
					},
				},
			],
		}));
		server.setRequestHandler("tools/call", async (request) => {
			calls++;
			return { content: [{ type: "text", text: String(request.params.arguments?.text) }] };
		});
		return server;
	}
	const handler = createMcpHandler(factory);
	const server = createServer((request, response) => {
		void (async () => {
			const url = new URL(request.url ?? "/", origin);
			const chunks: Buffer[] = [];
			for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
			const body = Buffer.concat(chunks).toString("utf8");
			const json = (value: unknown, status = 200) => {
				response.writeHead(status, { "content-type": "application/json" });
				response.end(JSON.stringify(value));
			};
			if (url.pathname.startsWith("/.well-known/oauth-protected-resource"))
				return json({ resource: `${origin}/mcp`, authorization_servers: [origin] });
			if (url.pathname.startsWith("/.well-known/oauth-authorization-server"))
				return json({
					issuer: origin,
					authorization_endpoint: `${origin}/authorize`,
					token_endpoint: `${origin}/token`,
					registration_endpoint: `${origin}/register`,
					response_types_supported: ["code"],
					grant_types_supported: ["authorization_code", "refresh_token"],
					code_challenge_methods_supported: ["S256"],
					token_endpoint_auth_methods_supported: ["none", "client_secret_basic"],
					authorization_response_iss_parameter_supported: true,
				});
			if (url.pathname === "/register") return json({ ...JSON.parse(body), client_id: "fixture-client" }, 201);
			if (url.pathname === "/authorize") {
				const code = randomUUID();
				const redirect = url.searchParams.get("redirect_uri")!;
				codes.set(code, { challenge: url.searchParams.get("code_challenge")!, redirectUri: redirect });
				const destination = new URL(redirect);
				destination.searchParams.set("code", code);
				destination.searchParams.set("state", url.searchParams.get("state")!);
				destination.searchParams.set("iss", origin);
				response.writeHead(303, { location: destination.href });
				response.end();
				return;
			}
			if (url.pathname === "/token") {
				const params = new URLSearchParams(body);
				if (params.get("grant_type") === "authorization_code") {
					const code = codes.get(params.get("code") ?? "");
					if (
						!code ||
						code.redirectUri !== params.get("redirect_uri") ||
						code.challenge !==
							createHash("sha256")
								.update(params.get("code_verifier") ?? "")
								.digest("base64url")
					)
						return json({ error: "invalid_grant" }, 400);
					codes.delete(params.get("code")!);
					exchanges++;
				} else if (
					params.get("grant_type") === "refresh_token" &&
					params.get("refresh_token") === "fixture-refresh"
				)
					refreshes++;
				else return json({ error: "invalid_grant" }, 400);
				const token = `fixture-access-${++sequence}`;
				tokens.add(token);
				return json({
					access_token: token,
					token_type: "Bearer",
					refresh_token: "fixture-refresh",
					expires_in: 3600,
				});
			}
			if (url.pathname === "/sse" && request.method === "GET") {
				const transport = new LegacySseTransport(response);
				const instance = factory();
				legacy.set(transport.id, { server: instance, transport });
				response.on("close", () => {
					legacy.delete(transport.id);
					void instance.close();
				});
				await instance.connect(transport);
				return;
			}
			if (url.pathname === "/messages" && request.method === "POST") {
				const entry = legacy.get(url.searchParams.get("id") ?? "");
				if (!entry) return json({ error: "missing session" }, 404);
				entry.transport.onmessage?.(parseJSONRPCMessage(JSON.parse(body)));
				response.writeHead(202);
				response.end();
				return;
			}
			if (url.pathname !== "/mcp") return json({ error: "not found" }, 404);
			if (options.oauth && !tokens.has(request.headers.authorization?.replace(/^Bearer /u, "") ?? "")) {
				response.writeHead(401, {
					"www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
				});
				response.end();
				return;
			}
			const controller = new AbortController();
			response.once("close", () => controller.abort());
			const headers = new Headers();
			for (const [name, value] of Object.entries(request.headers))
				if (value) headers.set(name, Array.isArray(value) ? value.join(",") : value);
			const result = await handler.fetch(
				new Request(url, { method: request.method, headers, body: body || undefined, signal: controller.signal }),
			);
			response.writeHead(result.status, Object.fromEntries(result.headers));
			if (result.body) for await (const chunk of result.body) response.write(Buffer.from(chunk));
			response.end();
		})().catch((error: unknown) => {
			if (!response.headersSent) response.writeHead(500);
			response.end(String(error));
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Missing fixture port");
	origin = `http://127.0.0.1:${address.port}`;
	return {
		origin,
		get calls() {
			return calls;
		},
		get refreshes() {
			return refreshes;
		},
		get exchanges() {
			return exchanges;
		},
		changeDefinition() {
			description = "Changed echo definition";
		},
		invalidateTokens() {
			tokens.clear();
		},
		async close() {
			for (const entry of legacy.values()) await entry.server.close();
			await handler.close();
			server.closeAllConnections();
			await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
		},
	};
}
