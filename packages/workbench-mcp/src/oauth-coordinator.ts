import type { McpConnection, McpConnectionRepository } from "@earendil-works/workbench-core";
import {
	Client,
	SSEClientTransport,
	StreamableHTTPClientTransport,
	type Transport,
} from "@modelcontextprotocol/client";
import { withConnectionLock } from "./connection-lock.ts";
import type { McpOAuthProviderResolver, McpSecretWriter } from "./connector.ts";
import { McpWorkbenchError } from "./errors.ts";
import { McpOAuthFlowStore } from "./oauth-flow-store.ts";
import { WorkbenchOAuthProvider } from "./oauth-provider.ts";

export interface BeginOAuthResult {
	flowId: string;
	status: "authorization_required" | "already_authorized";
	authorizationUrl?: string;
	expiresAt: string;
}

export class McpOAuthCoordinator implements McpOAuthProviderResolver {
	private readonly flows = new McpOAuthFlowStore();
	private readonly connections: McpConnectionRepository;
	private readonly secrets: McpSecretWriter;
	private callbackOrigin?: string;

	constructor(connections: McpConnectionRepository, secrets: McpSecretWriter) {
		this.connections = connections;
		this.secrets = secrets;
	}

	setCallbackOrigin(origin: string): void {
		const url = new URL(origin);
		if (
			url.protocol !== "http:" ||
			(url.hostname !== "127.0.0.1" && url.hostname !== "[::1]" && url.hostname !== "localhost")
		) {
			throw new McpWorkbenchError("oauth_failed", "OAuth callback origin must be a loopback HTTP origin");
		}
		this.callbackOrigin = url.origin;
	}

	async getOAuthProvider(connection: McpConnection) {
		return new WorkbenchOAuthProvider({
			connection,
			secrets: this.secrets,
			callbackUrl: this.callbackUrl(),
		});
	}

	async beginAuthorization(connectionId: string): Promise<BeginOAuthResult> {
		return withConnectionLock(connectionId, () => this.beginUnlocked(connectionId));
	}

	private async beginUnlocked(connectionId: string): Promise<BeginOAuthResult> {
		const connection = await this.requireConnection(connectionId);
		const flow = this.flows.create(connectionId, connection.version);
		const provider = new WorkbenchOAuthProvider({
			connection,
			secrets: this.secrets,
			callbackUrl: this.callbackUrl(),
			flow,
			onAuthorizationUrl: (url) => this.flows.setAuthorizationUrl(flow.id, url),
		});
		const transport = this.transport(connection, provider);
		const client = new Client({ name: "personal-workbench", version: "0.1.0" });
		try {
			await client.connect(transport, { timeout: 30_000 });
			return {
				flowId: flow.id,
				status: "already_authorized",
				expiresAt: new Date(flow.expiresAt).toISOString(),
			};
		} catch (error) {
			const current = this.flows.requireById(flow.id);
			if (!current.authorizationUrl) throw error;
			return {
				flowId: flow.id,
				status: "authorization_required",
				authorizationUrl: current.authorizationUrl,
				expiresAt: new Date(flow.expiresAt).toISOString(),
			};
		} finally {
			await client.close().catch(() => transport.close().catch(() => undefined));
		}
	}

	async completeAuthorization(params: URLSearchParams): Promise<{ connectionId: string }> {
		const state = params.get("state");
		if (!state) throw new McpWorkbenchError("oauth_failed", "OAuth callback did not include state");
		const flow = this.flows.requireByState(state);
		this.flows.complete(flow.id);
		return withConnectionLock(flow.connectionId, async () => {
			const connection = await this.requireConnection(flow.connectionId);
			if (connection.version !== flow.connectionVersion)
				throw new McpWorkbenchError(
					"oauth_failed",
					"Connection changed during authorization. Start a new authorization.",
				);
			const provider = new WorkbenchOAuthProvider({
				connection,
				secrets: this.secrets,
				callbackUrl: this.callbackUrl(),
				flow,
			});
			const transport = this.transport(connection, provider);
			try {
				if (transport instanceof StreamableHTTPClientTransport || transport instanceof SSEClientTransport) {
					await transport.finishAuth(params);
				} else throw new McpWorkbenchError("oauth_failed", "OAuth is only available for remote MCP transports");
				return { connectionId: connection.id };
			} finally {
				await transport.close().catch(() => undefined);
			}
		});
	}

	async disconnect(connectionId: string): Promise<void> {
		await withConnectionLock(connectionId, async () => {
			const connection = await this.requireConnection(connectionId);
			if (!connection.secretRef) return;
			const secret = (await this.secrets.getSecret(connection.secretRef)) ?? {};
			delete secret.oauth;
			await this.secrets.setSecret(connection.secretRef, secret);
			this.flows.invalidateConnection(connectionId);
		});
	}

	dispose(): void {
		this.flows.invalidateAll();
	}

	private transport(connection: McpConnection, provider: WorkbenchOAuthProvider): Transport {
		if (!connection.remote) throw new McpWorkbenchError("oauth_failed", "OAuth requires a remote MCP connection");
		const url = new URL(connection.remote.url);
		return connection.transport === "sse"
			? new SSEClientTransport(url, { authProvider: provider })
			: new StreamableHTTPClientTransport(url, { authProvider: provider });
	}

	private async requireConnection(id: string): Promise<McpConnection> {
		const connection = await this.connections.get(id);
		if (!connection) throw new McpWorkbenchError("oauth_failed", `MCP connection not found: ${id}`);
		if (connection.authKind !== "oauth") throw new McpWorkbenchError("oauth_failed", "Connection does not use OAuth");
		if (!connection.enabled) throw new McpWorkbenchError("connection_disabled", "MCP connection is disabled");
		return connection;
	}

	private callbackUrl(): URL {
		if (!this.callbackOrigin)
			throw new McpWorkbenchError("oauth_failed", "Workbench HTTP server is not ready for OAuth");
		return new URL("/api/v1/mcp/oauth/callback", this.callbackOrigin);
	}
}
