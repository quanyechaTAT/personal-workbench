import type {
	McpConnection,
	McpConnectionRepository,
	McpConnectionTestResult,
	McpConnector,
} from "@earendil-works/workbench-core";
import type {
	RuntimeToolBinding,
	RuntimeToolCall,
	RuntimeToolLease,
	RuntimeToolProgress,
	RuntimeToolProvider,
	RuntimeToolResult,
	RuntimeToolScope,
} from "@earendil-works/workbench-runtime";
import { Client, type Tool, type Transport } from "@modelcontextprotocol/client";
import { withConnectionLock } from "./connection-lock.ts";
import { McpWorkbenchError } from "./errors.ts";
import { adaptToolResult } from "./result-adapter.ts";
import { McpSchemaValidator } from "./schema-validator.ts";
import { toolRecords } from "./tool-catalog.ts";
import type { McpTransportFactory } from "./transport-factory.ts";

interface OpenConnection {
	connection: McpConnection;
	client: Client;
	transport: Transport;
	tools: Map<string, Tool>;
	closed: boolean;
}

interface BoundTool {
	binding: RuntimeToolBinding;
	connection: OpenConnection;
	tool: Tool;
}

export interface McpConnectionManagerOptions {
	connectTimeoutMs?: number;
	callTimeoutMs?: number;
	maxResultBytes?: number;
}

export class McpConnectionManager implements McpConnector, RuntimeToolProvider {
	private readonly repository: McpConnectionRepository;
	private readonly transports: McpTransportFactory;
	private readonly active = new Set<OpenConnection>();
	private readonly validator = new McpSchemaValidator();
	private readonly connectTimeoutMs: number;
	private readonly callTimeoutMs: number;
	private readonly maxResultBytes: number;
	private disposed = false;

	constructor(
		repository: McpConnectionRepository,
		transports: McpTransportFactory,
		options: McpConnectionManagerOptions = {},
	) {
		this.repository = repository;
		this.transports = transports;
		this.connectTimeoutMs = options.connectTimeoutMs ?? 30_000;
		this.callTimeoutMs = options.callTimeoutMs ?? 120_000;
		this.maxResultBytes = options.maxResultBytes ?? 2 * 1024 * 1024;
	}

	async test(connection: McpConnection, signal?: AbortSignal): Promise<McpConnectionTestResult> {
		const handle = await this.connect(connection, signal);
		try {
			const tools = [...handle.tools.values()];
			const server = handle.client.getServerVersion();
			return {
				tools: toolRecords(connection.id, tools, new Date().toISOString(), this.validator),
				serverName: server?.name,
				serverVersion: server?.version,
			};
		} finally {
			await this.closeConnection(handle);
		}
	}

	async open(scope: RuntimeToolScope, bindings: readonly RuntimeToolBinding[]): Promise<RuntimeToolLease> {
		this.assertAvailable();
		const requested = bindings.filter((binding) => binding.providerId === "mcp");
		const byConnection = new Map<string, RuntimeToolBinding[]>();
		for (const binding of requested) {
			const list = byConnection.get(binding.resourceId) ?? [];
			list.push(binding);
			byConnection.set(binding.resourceId, list);
		}
		const connections: OpenConnection[] = [];
		const bound = new Map<string, BoundTool>();
		try {
			for (const [connectionId, selected] of byConnection) {
				const connection = await this.repository.get(connectionId);
				if (!connection)
					throw new McpWorkbenchError("connection_failed", `MCP connection not found: ${connectionId}`);
				if (!connection.enabled)
					throw new McpWorkbenchError("connection_disabled", `MCP connection is disabled: ${connection.name}`);
				const handle = await this.connect(connection);
				connections.push(handle);
				const records = toolRecords(
					connection.id,
					[...handle.tools.values()],
					new Date().toISOString(),
					this.validator,
				);
				const recordsByName = new Map(records.map((record) => [record.name, record]));
				await this.repository.replaceTools(connection.id, records);
				for (const binding of selected) {
					const name = binding.resourceToolName;
					const tool = handle.tools.get(name);
					const record = recordsByName.get(name);
					if (!tool || !record) throw new McpWorkbenchError("tool_missing", `MCP tool is unavailable: ${name}`);
					if (record.diagnostic) throw new McpWorkbenchError("invalid_schema", record.diagnostic);
					if (record.definitionHash !== binding.descriptor.definitionHash) {
						throw new McpWorkbenchError(
							"tool_missing",
							`MCP tool definition changed: ${connection.name}/${name}`,
						);
					}
					bound.set(binding.descriptor.id, { binding, connection: handle, tool });
				}
			}
		} catch (error) {
			await Promise.allSettled(connections.map((handle) => this.closeConnection(handle)));
			throw error;
		}
		let closed = false;
		return {
			tools: requested.map((binding) => binding.descriptor),
			call: (input, options) => this.call(scope, bound, input, options),
			close: async () => {
				if (closed) return;
				closed = true;
				await Promise.allSettled(connections.map((handle) => this.closeConnection(handle)));
			},
		};
	}

	async closeByConnection(connectionId: string): Promise<void> {
		await Promise.allSettled(
			[...this.active]
				.filter((handle) => handle.connection.id === connectionId)
				.map((handle) => this.closeConnection(handle)),
		);
	}

	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		await Promise.allSettled([...this.active].map((handle) => this.closeConnection(handle)));
	}

	private async connect(connection: McpConnection, signal?: AbortSignal): Promise<OpenConnection> {
		return withConnectionLock(connection.id, () => this.connectUnlocked(connection, signal));
	}

	private async connectUnlocked(connection: McpConnection, signal?: AbortSignal): Promise<OpenConnection> {
		this.assertAvailable();
		const transport = await this.transports.create(connection);
		const client = new Client({ name: "personal-workbench", version: "0.1.0" });
		try {
			await client.connect(transport, { timeout: this.connectTimeoutMs, signal });
			const response = await client.listTools(undefined, {
				timeout: this.connectTimeoutMs,
				signal,
				cacheMode: "refresh",
			});
			const handle: OpenConnection = {
				connection,
				client,
				transport,
				tools: new Map(response.tools.map((tool) => [tool.name, tool])),
				closed: false,
			};
			this.active.add(handle);
			return handle;
		} catch (error) {
			await client.close().catch(() => transport.close().catch(() => undefined));
			throw new McpWorkbenchError(
				"connection_failed",
				"Cannot connect to MCP server; check connection settings and authorization",
				{
					cause: error,
				},
			);
		}
	}

	private async call(
		scope: RuntimeToolScope,
		bound: ReadonlyMap<string, BoundTool>,
		input: RuntimeToolCall,
		options: { signal: AbortSignal; onProgress(progress: RuntimeToolProgress): void },
	): Promise<RuntimeToolResult> {
		if (scope.workbenchSessionId !== input.sessionId) {
			throw new McpWorkbenchError("tool_missing", "MCP tool lease belongs to another Workbench session");
		}
		const selected = bound.get(input.toolId);
		if (!selected || selected.connection.closed)
			throw new McpWorkbenchError("tool_missing", `MCP tool is not bound: ${input.toolId}`);
		this.validator.validateArguments(
			selected.binding.descriptor.inputSchema,
			input.arguments,
			selected.binding.descriptor.definitionHash,
		);
		return withConnectionLock(selected.connection.connection.id, async () => {
			options.signal.throwIfAborted();
			if (selected.connection.closed)
				throw new McpWorkbenchError("connection_disabled", "MCP connection was closed");
			const current = await this.repository.get(selected.connection.connection.id);
			if (!current?.enabled || current.version !== selected.connection.connection.version)
				throw new McpWorkbenchError("connection_disabled", "MCP configuration changed");
			const discovered = await selected.connection.client.listTools(undefined, {
				cacheMode: "refresh",
				signal: options.signal,
				timeout: this.connectTimeoutMs,
			});
			const records = toolRecords(current.id, discovered.tools, new Date().toISOString(), this.validator);
			await this.repository.replaceTools(current.id, records);
			if (
				records.find((tool) => tool.name === selected.tool.name)?.definitionHash !==
				selected.binding.descriptor.definitionHash
			)
				throw new McpWorkbenchError(
					"tool_missing",
					"MCP tool definition changed; review its binding before calling it again",
				);
			const timeout = current.callTimeoutMs ?? this.callTimeoutMs;
			const result = await selected.connection.client.callTool(
				{ name: selected.tool.name, arguments: input.arguments },
				{
					signal: options.signal,
					timeout,
					maxTotalTimeout: timeout,
					resetTimeoutOnProgress: true,
					toolDefinition: selected.tool,
					onprogress: (progress) =>
						options.onProgress({
							message: progress.message,
							progress: progress.progress,
							total: progress.total,
						}),
				},
			);
			return adaptToolResult(result, this.maxResultBytes);
		});
	}

	private async closeConnection(handle: OpenConnection): Promise<void> {
		if (handle.closed) return;
		handle.closed = true;
		this.active.delete(handle);
		await handle.client.close();
	}

	private assertAvailable(): void {
		if (this.disposed) throw new McpWorkbenchError("connection_failed", "MCP connection manager has been disposed");
	}
}
