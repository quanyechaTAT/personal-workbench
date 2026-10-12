import { expect, test } from "vitest";
import { McpConnectionService } from "../src/mcp-connection-service.ts";
import type { McpConnection } from "../src/models.ts";
import type { McpConnectionRepository } from "../src/repositories.ts";

test("connection test failures persist a safe summary instead of remote error text", async () => {
	let saved: McpConnection | undefined;
	const repository = {
		create: async (value: McpConnection) => {
			saved = value;
			return value;
		},
		get: async (id: string) => (saved?.id === id ? saved : undefined),
		list: async () => (saved ? [saved] : []),
		update: async (value: McpConnection, expectedVersion: number) => {
			if (saved?.version !== expectedVersion) return undefined;
			saved = value;
			return value;
		},
		replaceTools: async () => undefined,
		listTools: async () => [],
	} satisfies McpConnectionRepository;
	const service = new McpConnectionService(repository, {
		test: async () => {
			throw new Error("Bearer secret-from-remote-server");
		},
		closeByConnection: async () => undefined,
		dispose: async () => undefined,
	});
	const connection = await service.create({
		name: "Local MCP",
		transport: "stdio",
		authKind: "none",
		stdio: { command: "node", args: [], environmentKeys: [] },
	});
	await expect(service.test(connection.id)).rejects.toThrow("secret-from-remote-server");
	expect(saved?.lastError).toBe("MCP connection test failed; check connection settings and server availability");
});
