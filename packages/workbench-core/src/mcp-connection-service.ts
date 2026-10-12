import { WorkbenchError } from "./errors.ts";
import type { McpConnectionTestResult, McpConnector } from "./mcp-ports.ts";
import type { McpAuthKind, McpConnection, McpRemoteConfig, McpStdioConfig, McpTransportKind } from "./models.ts";
import type { McpConnectionRepository } from "./repositories.ts";
import { defaultSystemServices, type SystemServices, toTimestamp } from "./system.ts";

export interface SaveMcpConnectionInput {
	callTimeoutMs?: number;
	name: string;
	transport: McpTransportKind;
	stdio?: McpStdioConfig;
	remote?: McpRemoteConfig;
	authKind: McpAuthKind;
	secretRef?: string;
	enabled?: boolean;
}

export class McpConnectionService {
	private readonly repository: McpConnectionRepository;
	private readonly connector: McpConnector;
	private readonly system: SystemServices;

	constructor(
		repository: McpConnectionRepository,
		connector: McpConnector,
		system: SystemServices = defaultSystemServices,
	) {
		this.repository = repository;
		this.connector = connector;
		this.system = system;
	}

	async create(input: SaveMcpConnectionInput): Promise<McpConnection> {
		this.validate(input);
		const now = toTimestamp(this.system.now());
		return this.repository.create({
			callTimeoutMs: input.callTimeoutMs,
			id: this.system.id(),
			name: input.name.trim(),
			transport: input.transport,
			stdio: input.transport === "stdio" ? normalizedStdio(input.stdio!) : undefined,
			remote: input.transport === "stdio" ? undefined : normalizedRemote(input.remote!),
			authKind: input.authKind,
			secretRef: input.secretRef,
			enabled: input.enabled ?? true,
			version: 1,
			createdAt: now,
			updatedAt: now,
		});
	}

	async update(id: string, input: SaveMcpConnectionInput, expectedVersion: number): Promise<McpConnection> {
		this.validate(input);
		const current = await this.get(id);
		if (current.version !== expectedVersion)
			throw new WorkbenchError("conflict", "MCP connection changed since it was loaded");
		const next: McpConnection = {
			...current,
			callTimeoutMs: input.callTimeoutMs,
			name: input.name.trim(),
			transport: input.transport,
			stdio: input.transport === "stdio" ? normalizedStdio(input.stdio!) : undefined,
			remote: input.transport === "stdio" ? undefined : normalizedRemote(input.remote!),
			authKind: input.authKind,
			secretRef: input.secretRef,
			enabled: input.enabled ?? current.enabled,
			version: current.version + 1,
			lastError: undefined,
			updatedAt: toTimestamp(this.system.now()),
		};
		const saved = await this.repository.update(next, expectedVersion);
		if (!saved) throw new WorkbenchError("conflict", "MCP connection changed since it was loaded");
		await this.connector.closeByConnection(id);
		return saved;
	}

	async setEnabled(id: string, enabled: boolean, expectedVersion: number): Promise<McpConnection> {
		const current = await this.get(id);
		if (current.version !== expectedVersion)
			throw new WorkbenchError("conflict", "MCP connection changed since it was loaded");
		const saved = await this.repository.update(
			{
				...current,
				enabled,
				version: current.version + 1,
				updatedAt: toTimestamp(this.system.now()),
			},
			expectedVersion,
		);
		if (!saved) throw new WorkbenchError("conflict", "MCP connection changed since it was loaded");
		await this.connector.closeByConnection(id);
		return saved;
	}

	async test(id: string, signal?: AbortSignal): Promise<McpConnectionTestResult> {
		const connection = await this.get(id);
		try {
			const result = await this.connector.test(connection, signal);
			await this.repository.replaceTools(id, result.tools);
			await this.repository.update(
				{
					...connection,
					lastConnectedAt: toTimestamp(this.system.now()),
					lastError: undefined,
					updatedAt: toTimestamp(this.system.now()),
				},
				connection.version,
			);
			return result;
		} catch (error) {
			await this.repository.update(
				{
					...connection,
					lastError: "MCP connection test failed; check connection settings and server availability",
					updatedAt: toTimestamp(this.system.now()),
				},
				connection.version,
			);
			throw error;
		}
	}

	discoverTools(id: string, signal?: AbortSignal): Promise<McpConnectionTestResult> {
		return this.test(id, signal);
	}

	async get(id: string): Promise<McpConnection> {
		const value = await this.repository.get(id);
		if (!value) throw new WorkbenchError("not_found", `MCP connection not found: ${id}`);
		return value;
	}

	list(): Promise<McpConnection[]> {
		return this.repository.list();
	}

	async listTools(id: string) {
		await this.get(id);
		return this.repository.listTools(id);
	}

	private validate(input: SaveMcpConnectionInput): void {
		if (!input.name.trim()) throw new WorkbenchError("invalid_input", "Connection name is required");
		if (input.transport === "stdio") {
			if (!input.stdio?.command.trim()) throw new WorkbenchError("invalid_input", "stdio command is required");
			if (input.remote) throw new WorkbenchError("invalid_input", "stdio connections cannot include a remote URL");
			if (input.authKind !== "none")
				throw new WorkbenchError("invalid_input", "stdio authentication uses process environment secrets");
		} else {
			if (!input.remote?.url.trim()) throw new WorkbenchError("invalid_input", "Remote MCP URL is required");
			let url: URL;
			try {
				url = new URL(input.remote.url);
			} catch {
				throw new WorkbenchError("invalid_input", "Remote MCP URL is invalid");
			}
			const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
			if (url.username || url.password || url.hash)
				throw new WorkbenchError("invalid_input", "Put credentials in the authentication fields, not the MCP URL");
			if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
				throw new WorkbenchError(
					"invalid_input",
					"Remote MCP must use HTTPS, except for loopback development servers",
				);
			}
			if (input.stdio)
				throw new WorkbenchError("invalid_input", "Remote connections cannot include a stdio command");
			if (input.authKind !== "none" && !input.secretRef) {
				throw new WorkbenchError("invalid_input", "Authenticated MCP connections require a secret reference");
			}
		}
	}
}

function normalizedStdio(value: McpStdioConfig): McpStdioConfig {
	return {
		command: value.command.trim(),
		args: [...value.args],
		cwd: value.cwd?.trim() || undefined,
		environmentKeys: [...new Set(value.environmentKeys.map((key) => key.trim()).filter(Boolean))],
	};
}

function normalizedRemote(value: McpRemoteConfig): McpRemoteConfig {
	return {
		url: value.url.trim(),
		headerNames: [...new Set(value.headerNames.map((name) => name.trim()).filter(Boolean))],
		clientId: value.clientId?.trim() || undefined,
	};
}
