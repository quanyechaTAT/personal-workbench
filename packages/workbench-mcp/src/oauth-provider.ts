import type { McpConnection } from "@earendil-works/workbench-core";
import type {
	OAuthClientInformationContext,
	OAuthClientMetadata,
	OAuthClientProvider,
	OAuthDiscoveryState,
	StoredOAuthClientInformation,
	StoredOAuthTokens,
} from "@modelcontextprotocol/client";
import { withConnectionLock } from "./connection-lock.ts";
import type { McpOAuthSecret, McpSecretValue, McpSecretWriter } from "./connector.ts";
import { McpWorkbenchError } from "./errors.ts";
import type { McpOAuthFlow } from "./oauth-flow-store.ts";

export class WorkbenchOAuthProvider implements OAuthClientProvider {
	private readonly connection: McpConnection;
	private readonly secrets: McpSecretWriter;
	private readonly callbackUrl: URL;
	private readonly flow?: McpOAuthFlow;
	private readonly onAuthorizationUrl?: (url: URL) => void;

	constructor(options: {
		connection: McpConnection;
		secrets: McpSecretWriter;
		callbackUrl: URL;
		flow?: McpOAuthFlow;
		onAuthorizationUrl?(url: URL): void;
	}) {
		this.connection = options.connection;
		this.secrets = options.secrets;
		this.callbackUrl = options.callbackUrl;
		this.flow = options.flow;
		this.onAuthorizationUrl = options.onAuthorizationUrl;
	}

	get redirectUrl(): URL {
		return this.callbackUrl;
	}

	get clientMetadata(): OAuthClientMetadata {
		return {
			client_name: "Personal Workbench",
			redirect_uris: [this.callbackUrl.toString()],
			grant_types: ["authorization_code", "refresh_token"],
			response_types: ["code"],
			token_endpoint_auth_method: "none",
		};
	}

	state(): string {
		if (!this.flow) throw new McpWorkbenchError("authentication_required", "Start OAuth from the Connections page");
		return this.flow.state;
	}

	async clientInformation(ctx?: OAuthClientInformationContext): Promise<StoredOAuthClientInformation | undefined> {
		const secret = await this.read();
		const oauth = secret.oauth;
		const issuer = ctx?.issuer ?? oauth?.latestIssuer;
		if (issuer && oauth?.clients[issuer]) return oauth.clients[issuer];
		const clientId = this.connection.remote?.clientId;
		return clientId
			? {
					client_id: clientId,
					client_secret: secret.clientSecret,
					token_endpoint_auth_method: secret.clientSecret ? "client_secret_basic" : "none",
				}
			: undefined;
	}

	async saveClientInformation(
		clientInformation: StoredOAuthClientInformation,
		ctx?: OAuthClientInformationContext,
	): Promise<void> {
		await this.updateOAuth((oauth) => {
			const issuer = ctx?.issuer ?? clientInformation.issuer ?? "default";
			oauth.clients[issuer] = clientInformation;
			oauth.latestIssuer = issuer;
		});
	}

	async tokens(ctx?: OAuthClientInformationContext): Promise<StoredOAuthTokens | undefined> {
		const oauth = (await this.read()).oauth;
		const issuer = ctx?.issuer ?? oauth?.latestIssuer;
		return issuer ? oauth?.tokens[issuer] : undefined;
	}

	async saveTokens(tokens: StoredOAuthTokens, ctx?: OAuthClientInformationContext): Promise<void> {
		await this.updateOAuth((oauth) => {
			const issuer = ctx?.issuer ?? tokens.issuer ?? "default";
			oauth.tokens[issuer] = tokens;
			oauth.latestIssuer = issuer;
		});
	}

	redirectToAuthorization(authorizationUrl: URL): void {
		if (!this.flow || !this.onAuthorizationUrl) {
			throw new McpWorkbenchError("authentication_required", "MCP connection requires OAuth authorization");
		}
		this.onAuthorizationUrl(authorizationUrl);
	}

	async saveCodeVerifier(codeVerifier: string): Promise<void> {
		if (!this.flow) throw new McpWorkbenchError("authentication_required", "Start OAuth from Connections");
		this.flow.codeVerifier = codeVerifier;
	}

	async codeVerifier(): Promise<string> {
		const verifier = this.flow?.codeVerifier;
		if (!verifier) throw new McpWorkbenchError("oauth_failed", "OAuth PKCE verifier is unavailable");
		return verifier;
	}

	async invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): Promise<void> {
		if (scope === "all" || scope === "verifier") {
			if (this.flow) delete this.flow.codeVerifier;
		}
		await this.updateOAuth((oauth) => {
			if (scope === "all" || scope === "client") oauth.clients = {};
			if (scope === "all" || scope === "tokens") oauth.tokens = {};
			if (scope === "all" || scope === "verifier") delete oauth.codeVerifier;
			if (scope === "all" || scope === "discovery") delete oauth.discoveryState;
			if (scope === "all") delete oauth.latestIssuer;
		});
	}

	async saveDiscoveryState(discoveryState: OAuthDiscoveryState): Promise<void> {
		await this.updateOAuth((oauth) => {
			oauth.discoveryState = discoveryState;
		});
	}

	async discoveryState(): Promise<OAuthDiscoveryState | undefined> {
		return (await this.read()).oauth?.discoveryState;
	}

	async saveResourceUrl(resourceUrl: string): Promise<void> {
		await this.updateOAuth((oauth) => {
			oauth.resourceUrl = resourceUrl;
		});
	}

	async resourceUrl(): Promise<string | undefined> {
		return (await this.read()).oauth?.resourceUrl;
	}

	private async read(): Promise<McpSecretValue> {
		if (!this.connection.secretRef)
			throw new McpWorkbenchError("authentication_required", "OAuth secret reference is missing");
		return (await this.secrets.getSecret(this.connection.secretRef)) ?? {};
	}

	private async updateOAuth(update: (oauth: McpOAuthSecret) => void): Promise<void> {
		if (!this.connection.secretRef)
			throw new McpWorkbenchError("authentication_required", "OAuth secret reference is missing");
		const reference = this.connection.secretRef;
		await withConnectionLock(`secret:${reference}`, async () => {
			const current = await this.read();
			const oauth = ensureOAuth(current.oauth);
			update(oauth);
			await this.secrets.setSecret(reference, { ...current, oauth });
		});
	}
}

function ensureOAuth(value?: McpOAuthSecret): McpOAuthSecret {
	return value ?? { clients: {}, tokens: {} };
}
