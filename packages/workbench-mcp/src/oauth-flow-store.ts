import { randomBytes, randomUUID } from "node:crypto";
import { McpWorkbenchError } from "./errors.ts";

export interface McpOAuthFlow {
	id: string;
	connectionId: string;
	connectionVersion: number;
	codeVerifier?: string;
	state: string;
	createdAt: number;
	expiresAt: number;
	used: boolean;
	authorizationUrl?: string;
}

export class McpOAuthFlowStore {
	private readonly flows = new Map<string, McpOAuthFlow>();
	private readonly ttlMs: number;

	constructor(ttlMs = 10 * 60_000) {
		this.ttlMs = ttlMs;
	}

	create(connectionId: string, connectionVersion = 1): McpOAuthFlow {
		this.purge();
		for (const [id, value] of this.flows) if (value.connectionId === connectionId) this.flows.delete(id);
		const createdAt = Date.now();
		const flow: McpOAuthFlow = {
			id: randomUUID(),
			connectionId,
			connectionVersion,
			state: randomBytes(32).toString("base64url"),
			createdAt,
			expiresAt: createdAt + this.ttlMs,
			used: false,
		};
		this.flows.set(flow.id, flow);
		return flow;
	}

	setAuthorizationUrl(id: string, url: URL): void {
		const flow = this.requireById(id);
		flow.authorizationUrl = url.toString();
	}

	requireByState(state: string): McpOAuthFlow {
		this.purge();
		const flow = [...this.flows.values()].find((candidate) => candidate.state === state);
		if (!flow) throw new McpWorkbenchError("oauth_failed", "OAuth state is invalid or expired");
		return this.assertOpen(flow);
	}

	requireById(id: string): McpOAuthFlow {
		this.purge();
		const flow = this.flows.get(id);
		if (!flow) throw new McpWorkbenchError("oauth_failed", "OAuth flow is invalid or expired");
		return this.assertOpen(flow);
	}

	complete(id: string): void {
		const flow = this.requireById(id);
		flow.used = true;
	}

	invalidateAll(): void {
		this.flows.clear();
	}

	invalidateConnection(connectionId: string): void {
		for (const [id, flow] of this.flows) if (flow.connectionId === connectionId) this.flows.delete(id);
	}

	private assertOpen(flow: McpOAuthFlow): McpOAuthFlow {
		if (flow.used) throw new McpWorkbenchError("oauth_failed", "OAuth callback was already used");
		if (flow.expiresAt <= Date.now()) throw new McpWorkbenchError("oauth_failed", "OAuth flow expired");
		return flow;
	}

	private purge(): void {
		const now = Date.now();
		for (const [id, flow] of this.flows) if (flow.expiresAt <= now || flow.used) this.flows.delete(id);
	}
}
