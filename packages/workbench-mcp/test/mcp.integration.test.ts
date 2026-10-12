import { fileURLToPath } from "node:url";
import type { McpConnection, McpConnectionRepository, McpToolRecord } from "@earendil-works/workbench-core";
import type { RuntimeToolBinding, RuntimeToolScope } from "@earendil-works/workbench-runtime";
import { describe, expect, test } from "vitest";
import { McpConnectionManager } from "../src/connection-manager.ts";
import { McpOAuthFlowStore } from "../src/oauth-flow-store.ts";
import { McpSchemaValidator } from "../src/schema-validator.ts";
import { toolRecords } from "../src/tool-catalog.ts";
import { McpTransportFactory } from "../src/transport-factory.ts";

class ConnectionRepository implements McpConnectionRepository {
	readonly connections = new Map<string, McpConnection>();
	readonly tools = new Map<string, McpToolRecord[]>();
	async create(value: McpConnection) {
		this.connections.set(value.id, value);
		return value;
	}
	async get(id: string) {
		return this.connections.get(id);
	}
	async list() {
		return [...this.connections.values()];
	}
	async update(value: McpConnection, version: number) {
		if (this.connections.get(value.id)?.version !== version) return undefined;
		this.connections.set(value.id, value);
		return value;
	}
	async replaceTools(id: string, tools: McpToolRecord[]) {
		this.tools.set(id, tools);
	}
	async listTools(id: string) {
		return this.tools.get(id) ?? [];
	}
}

describe("MCP protocol integration", () => {
	test("discovers and calls a real stdio server, enforces arguments, cancels and closes leases", async () => {
		const repository = new ConnectionRepository();
		const connection = await repository.create({
			id: "fixture",
			name: "Fixture",
			transport: "stdio",
			authKind: "none",
			enabled: true,
			version: 1,
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
			stdio: {
				command: process.execPath,
				args: [fileURLToPath(new URL("./fixtures/stdio-server.mjs", import.meta.url))],
				environmentKeys: [],
			},
		});
		const manager = new McpConnectionManager(
			repository,
			new McpTransportFactory({ getSecret: async () => undefined }),
		);
		try {
			const discovered = await manager.test(connection);
			expect(discovered.tools.map((tool) => tool.name)).toEqual(["echo", "fail", "wait"]);
			const scope: RuntimeToolScope = {
				workbenchSessionId: "session",
				assistantId: "assistant",
				assistantVersion: 1,
				cwd: process.cwd(),
			};
			const bindings: RuntimeToolBinding[] = discovered.tools.map((tool) => ({
				providerId: "mcp",
				resourceId: connection.id,
				resourceToolName: tool.name,
				approval: "ask",
				descriptor: {
					id: `opaque-${tool.name}`,
					name: `fixture_${tool.name}`,
					label: tool.name,
					description: tool.description,
					inputSchema: tool.inputSchema,
					definitionHash: tool.definitionHash,
				},
			}));
			const lease = await manager.open(scope, bindings);
			const call = (tool: string, args: Record<string, unknown>, signal = new AbortController().signal) =>
				lease.call(
					{
						toolId: `opaque-${tool}`,
						arguments: args,
						sessionId: scope.workbenchSessionId,
						runtimeSessionId: "runtime",
						runId: "run",
						toolCallId: tool,
					},
					{ signal, onProgress: () => undefined },
				);
			expect(await call("echo", { text: "中文 protocol test" })).toMatchObject({
				isError: false,
				structuredContent: { text: "中文 protocol test" },
			});
			expect(await call("fail", {})).toMatchObject({ isError: true });
			await expect(call("echo", { text: 42 })).rejects.toThrow();
			const abort = new AbortController();
			const waiting = call("wait", {}, abort.signal);
			abort.abort();
			await expect(waiting).rejects.toThrow();
			await lease.close();
			await expect(call("echo", { text: "closed" })).rejects.toThrow();
		} finally {
			await manager.dispose();
		}
	}, 30_000);

	test("rejects external schema references and invalid OAuth callbacks", () => {
		const validator = new McpSchemaValidator();
		expect(() =>
			validator.assertSupported({ type: "object", properties: { x: { $ref: "https://example.org/schema" } } }),
		).toThrow("External");
		const records = toolRecords(
			"connection",
			[
				{
					name: "unsupported",
					inputSchema: { type: "object", properties: { x: { $ref: "https://example.org/schema" } } },
				},
				{ name: "valid", inputSchema: { type: "object" } },
			],
			new Date().toISOString(),
			validator,
		);
		expect(records[0].diagnostic).toContain("External");
		expect(records[1].diagnostic).toBeUndefined();
		const store = new McpOAuthFlowStore();
		const flow = store.create("connection", 3);
		expect(store.requireByState(flow.state).connectionVersion).toBe(3);
		store.complete(flow.id);
		expect(() => store.requireByState(flow.state)).toThrow();
		expect(() => store.requireByState("wrong-state")).toThrow();
		const expired = new McpOAuthFlowStore(-1);
		const old = expired.create("connection");
		expect(() => expired.requireByState(old.state)).toThrow();
	});
});
