import type {
	McpConnection,
	McpConnectionRepository,
	McpRemoteConfig,
	McpStdioConfig,
	McpToolRecord,
} from "@earendil-works/workbench-core";
import type { WorkbenchDatabase } from "./database.ts";

interface ConnectionRow {
	id: string;
	name: string;
	transport: McpConnection["transport"];
	config_json: string;
	auth_kind: McpConnection["authKind"];
	secret_ref: string | null;
	enabled: number;
	version: number;
	last_connected_at: string | null;
	last_error: string | null;
	created_at: string;
	updated_at: string;
}

interface ToolRow {
	diagnostic: string | null;
	connection_id: string;
	name: string;
	title: string | null;
	description: string;
	input_schema_json: string;
	definition_hash: string;
	read_only_hint: number | null;
	destructive_hint: number | null;
	discovered_at: string;
}

function mapConnection(row: ConnectionRow): McpConnection {
	const config = JSON.parse(row.config_json) as {
		stdio?: McpStdioConfig;
		remote?: McpRemoteConfig;
		callTimeoutMs?: number;
	};
	return {
		id: row.id,
		name: row.name,
		transport: row.transport,
		stdio: config.stdio,
		remote: config.remote,
		callTimeoutMs: config.callTimeoutMs,
		authKind: row.auth_kind,
		secretRef: row.secret_ref ?? undefined,
		enabled: row.enabled === 1,
		version: row.version,
		lastConnectedAt: row.last_connected_at ?? undefined,
		lastError: row.last_error ?? undefined,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function mapTool(row: ToolRow): McpToolRecord {
	return {
		diagnostic: row.diagnostic ?? undefined,
		connectionId: row.connection_id,
		name: row.name,
		title: row.title ?? undefined,
		description: row.description,
		inputSchema: JSON.parse(row.input_schema_json) as Record<string, unknown>,
		definitionHash: row.definition_hash,
		readOnlyHint: row.read_only_hint === null ? undefined : row.read_only_hint === 1,
		destructiveHint: row.destructive_hint === null ? undefined : row.destructive_hint === 1,
		discoveredAt: row.discovered_at,
	};
}

export class SqliteMcpConnectionRepository implements McpConnectionRepository {
	private readonly database: WorkbenchDatabase;

	constructor(database: WorkbenchDatabase) {
		this.database = database;
	}

	async create(connection: McpConnection): Promise<McpConnection> {
		this.database
			.prepare(
				`INSERT INTO mcp_connections(
          id, name, transport, config_json, auth_kind, secret_ref, enabled, version,
          last_connected_at, last_error, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(...this.values(connection));
		return connection;
	}

	async get(id: string): Promise<McpConnection | undefined> {
		const row = this.database.prepare("SELECT * FROM mcp_connections WHERE id = ?").get(id) as
			| ConnectionRow
			| undefined;
		return row ? mapConnection(row) : undefined;
	}

	async list(): Promise<McpConnection[]> {
		const rows = this.database
			.prepare("SELECT * FROM mcp_connections ORDER BY name")
			.all() as unknown as ConnectionRow[];
		return rows.map(mapConnection);
	}

	async update(connection: McpConnection, expectedVersion: number): Promise<McpConnection | undefined> {
		const result = this.database
			.prepare(
				`UPDATE mcp_connections SET name = ?, transport = ?, config_json = ?, auth_kind = ?,
         secret_ref = ?, enabled = ?, version = ?, last_connected_at = ?, last_error = ?, updated_at = ?
         WHERE id = ? AND version = ?`,
			)
			.run(
				connection.name,
				connection.transport,
				JSON.stringify({
					stdio: connection.stdio,
					remote: connection.remote,
					callTimeoutMs: connection.callTimeoutMs,
				}),
				connection.authKind,
				connection.secretRef ?? null,
				connection.enabled ? 1 : 0,
				connection.version,
				connection.lastConnectedAt ?? null,
				connection.lastError ?? null,
				connection.updatedAt,
				connection.id,
				expectedVersion,
			);
		return result.changes === 1 ? connection : undefined;
	}

	async replaceTools(connectionId: string, tools: McpToolRecord[]): Promise<void> {
		this.database.transaction(() => {
			this.database.prepare("DELETE FROM mcp_tools WHERE connection_id = ?").run(connectionId);
			const insert = this.database.prepare(
				`INSERT INTO mcp_tools(
           connection_id, name, title, description, input_schema_json, definition_hash,
           read_only_hint, destructive_hint, discovered_at, diagnostic
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			);
			for (const tool of tools) {
				insert.run(
					connectionId,
					tool.name,
					tool.title ?? null,
					tool.description,
					JSON.stringify(tool.inputSchema),
					tool.definitionHash,
					tool.readOnlyHint === undefined ? null : tool.readOnlyHint ? 1 : 0,
					tool.destructiveHint === undefined ? null : tool.destructiveHint ? 1 : 0,
					tool.discoveredAt,
					tool.diagnostic ?? null,
				);
			}
		});
	}

	async listTools(connectionId: string): Promise<McpToolRecord[]> {
		const rows = this.database
			.prepare("SELECT * FROM mcp_tools WHERE connection_id = ? ORDER BY name")
			.all(connectionId) as unknown as ToolRow[];
		return rows.map(mapTool);
	}

	private values(connection: McpConnection): Array<string | number | null> {
		return [
			connection.id,
			connection.name,
			connection.transport,
			JSON.stringify({
				stdio: connection.stdio,
				remote: connection.remote,
				callTimeoutMs: connection.callTimeoutMs,
			}),
			connection.authKind,
			connection.secretRef ?? null,
			connection.enabled ? 1 : 0,
			connection.version,
			connection.lastConnectedAt ?? null,
			connection.lastError ?? null,
			connection.createdAt,
			connection.updatedAt,
		];
	}
}
