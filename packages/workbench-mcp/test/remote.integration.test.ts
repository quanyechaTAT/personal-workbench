import { createServer } from "node:http";
import type { McpConnection, McpConnectionRepository, McpToolRecord } from "@earendil-works/workbench-core";
import type { RuntimeToolBinding } from "@earendil-works/workbench-runtime";
import { expect, test } from "vitest";
import { McpConnectionManager } from "../src/connection-manager.ts";
import type { McpSecretValue } from "../src/connector.ts";
import type { McpWorkbenchError } from "../src/errors.ts";
import { McpOAuthCoordinator } from "../src/oauth-coordinator.ts";
import { McpTransportFactory } from "../src/transport-factory.ts";
import { startRemoteMcpFixture } from "./fixtures/remote-server.ts";

class Repository implements McpConnectionRepository {
	connection: McpConnection;
	tools: McpToolRecord[] = [];
	constructor(connection: McpConnection) {
		this.connection = connection;
	}
	async create(value: McpConnection) {
		this.connection = value;
		return value;
	}
	async get() {
		return this.connection;
	}
	async list() {
		return [this.connection];
	}
	async update(value: McpConnection) {
		this.connection = value;
		return value;
	}
	async replaceTools(_id: string, values: McpToolRecord[]) {
		this.tools = values;
	}
	async listTools() {
		return this.tools;
	}
}

function connection(url: string, transport: McpConnection["transport"], oauth = false): McpConnection {
	return {
		id: `test-${Math.random()}`,
		name: "HTTP fixture",
		transport,
		remote: { url, headerNames: [] },
		authKind: oauth ? "oauth" : "none",
		secretRef: oauth ? "secret" : undefined,
		enabled: true,
		version: 1,
		createdAt: "",
		updatedAt: "",
	};
}

test("failed remote handshake does not expose remote response text", async () => {
	const server = createServer((_request, response) => {
		response.writeHead(503, { "content-type": "text/plain" });
		response.end("Bearer server-secret-must-stay-private");
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Expected a TCP test listener");
	const repository = new Repository(connection(`http://127.0.0.1:${address.port}/mcp`, "streamable-http"));
	const manager = new McpConnectionManager(repository, new McpTransportFactory({ getSecret: async () => undefined }));
	try {
		await expect(manager.test(repository.connection)).rejects.toMatchObject({
			code: "connection_failed",
			message: "Cannot connect to MCP server; check connection settings and authorization",
		} satisfies Partial<McpWorkbenchError>);
	} finally {
		await manager.dispose();
		await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
	}
}, 30_000);

test.each(["streamable-http", "sse"] as const)(
	"%s discovery, execution and definition revocation use a real protocol server",
	async (transport) => {
		const remote = await startRemoteMcpFixture();
		const repository = new Repository(
			connection(`${remote.origin}/${transport === "sse" ? "sse" : "mcp"}`, transport),
		);
		const manager = new McpConnectionManager(
			repository,
			new McpTransportFactory({ getSecret: async () => undefined }),
		);
		try {
			const discovery = await manager.test(repository.connection);
			const tool = discovery.tools[0];
			const binding: RuntimeToolBinding = {
				providerId: "mcp",
				resourceId: repository.connection.id,
				resourceToolName: tool.name,
				approval: "allow",
				descriptor: {
					id: "echo",
					name: "echo",
					label: "Echo",
					description: tool.description,
					inputSchema: tool.inputSchema,
					definitionHash: tool.definitionHash,
				},
			};
			const lease = await manager.open(
				{ workbenchSessionId: "session", assistantId: "profile", assistantVersion: 1, cwd: process.cwd() },
				[binding],
			);
			const call = () =>
				lease.call(
					{
						toolId: "echo",
						arguments: { text: "真实协议" },
						sessionId: "session",
						runtimeSessionId: "pi",
						runId: "run",
						toolCallId: "call",
					},
					{ signal: new AbortController().signal, onProgress: () => undefined },
				);
			expect((await call()).content).toEqual([{ type: "text", text: "真实协议" }]);
			remote.changeDefinition();
			await expect(call()).rejects.toThrow("definition changed");
			expect(remote.calls).toBe(1);
			await lease.close();
		} finally {
			await manager.dispose();
			await remote.close();
		}
	},
	30_000,
);

test("OAuth performs PKCE exchange, rejects wrong issuer and replay, refreshes tokens and disconnects", async () => {
	const remote = await startRemoteMcpFixture({ oauth: true });
	const repository = new Repository(connection(`${remote.origin}/mcp`, "streamable-http", true));
	let secret: McpSecretValue = {};
	const secrets = {
		getSecret: async () => structuredClone(secret),
		setSecret: async (_reference: string, value: McpSecretValue) => {
			secret = structuredClone(value);
		},
	};
	const oauth = new McpOAuthCoordinator(repository, secrets);
	oauth.setCallbackOrigin("http://127.0.0.1:4242");
	const manager = new McpConnectionManager(repository, new McpTransportFactory(secrets, oauth));
	try {
		const first = await oauth.beginAuthorization(repository.connection.id);
		expect(first.status).toBe("authorization_required");
		const denied = await fetch(first.authorizationUrl!, { redirect: "manual" });
		const bad = new URL(denied.headers.get("location")!);
		bad.searchParams.set("iss", "https://wrong.example");
		await expect(oauth.completeAuthorization(bad.searchParams)).rejects.toThrow();
		expect(remote.exchanges).toBe(0);
		const second = await oauth.beginAuthorization(repository.connection.id);
		const redirect = await fetch(second.authorizationUrl!, { redirect: "manual" });
		const callback = new URL(redirect.headers.get("location")!);
		await oauth.completeAuthorization(callback.searchParams);
		await expect(oauth.completeAuthorization(callback.searchParams)).rejects.toThrow();
		expect(remote.exchanges).toBe(1);
		expect((await manager.test(repository.connection)).tools).toHaveLength(1);
		remote.invalidateTokens();
		expect((await manager.test(repository.connection)).tools).toHaveLength(1);
		expect(remote.refreshes).toBeGreaterThan(0);
		await oauth.disconnect(repository.connection.id);
		expect(secret.oauth).toBeUndefined();
	} finally {
		await manager.dispose();
		oauth.dispose();
		await remote.close();
	}
}, 30_000);
