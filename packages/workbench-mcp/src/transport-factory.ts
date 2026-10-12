import type { McpConnection } from "@earendil-works/workbench-core";
import {
	type AuthProvider,
	type OAuthClientProvider,
	SSEClientTransport,
	StreamableHTTPClientTransport,
	type Transport,
} from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import type { McpOAuthProviderResolver, McpSecretResolver, McpSecretValue } from "./connector.ts";
import { McpWorkbenchError } from "./errors.ts";

export class McpTransportFactory {
	private readonly secrets: McpSecretResolver;
	private readonly oauth?: McpOAuthProviderResolver;

	constructor(secrets: McpSecretResolver, oauth?: McpOAuthProviderResolver) {
		this.secrets = secrets;
		this.oauth = oauth;
	}

	async create(connection: McpConnection): Promise<Transport> {
		const secret = connection.secretRef ? await this.secrets.getSecret(connection.secretRef) : undefined;
		if (connection.transport === "stdio") return this.createStdio(connection, secret);
		if (!connection.remote) throw new McpWorkbenchError("connection_failed", "Remote MCP URL is missing");
		const authProvider = await this.authProvider(connection, secret);
		const allowed = new Set(connection.remote.headerNames.map((name) => name.toLowerCase()));
		const headers = Object.fromEntries(
			Object.entries(secret?.headers ?? {}).filter(([name]) => allowed.has(name.toLowerCase())),
		);
		const fetchWithHeaders =
			connection.authKind === "headers" ? withHeaders(headers, new URL(connection.remote.url).origin) : undefined;
		const url = new URL(connection.remote.url);
		if (connection.transport === "sse") {
			return new SSEClientTransport(url, { authProvider, fetch: fetchWithHeaders });
		}
		return new StreamableHTTPClientTransport(url, { authProvider, fetch: fetchWithHeaders });
	}

	private createStdio(connection: McpConnection, secret?: McpSecretValue): StdioClientTransport {
		const config = connection.stdio;
		if (!config) throw new McpWorkbenchError("connection_failed", "stdio MCP command is missing");
		const env = getDefaultEnvironment();
		for (const key of config.environmentKeys) {
			const value = secret?.environment?.[key] ?? process.env[key];
			if (value !== undefined) env[key] = value;
		}
		const transport = new StdioClientTransport({
			command: config.command,
			args: config.args,
			cwd: config.cwd,
			env,
			stderr: "pipe",
		});
		// Drain stderr without persisting arbitrary server output, which can contain credentials.
		transport.stderr?.on("data", () => undefined);
		return transport;
	}

	private async authProvider(
		connection: McpConnection,
		secret?: McpSecretValue,
	): Promise<AuthProvider | OAuthClientProvider | undefined> {
		if (connection.authKind === "none") return undefined;
		if (connection.authKind === "oauth") {
			if (!this.oauth) throw new McpWorkbenchError("authentication_required", "OAuth is not configured");
			return this.oauth.getOAuthProvider(connection);
		}
		if (!secret?.bearerToken) return undefined;
		return { token: async () => secret.bearerToken };
	}
}

function withHeaders(headers: Record<string, string>, origin: string): typeof fetch {
	return async (input, init) => {
		const url = new URL(input instanceof Request ? input.url : input.toString());
		if (url.origin !== origin)
			throw new McpWorkbenchError("connection_failed", "Authenticated MCP requests cannot change origin");
		const merged = new Headers(init?.headers);
		for (const [name, value] of Object.entries(headers)) merged.set(name, value);
		return fetch(input, { ...init, headers: merged, redirect: "error" });
	};
}
