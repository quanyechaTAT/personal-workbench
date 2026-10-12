import type { McpConnection } from "@earendil-works/workbench-core";
import type {
	OAuthClientProvider,
	OAuthDiscoveryState,
	StoredOAuthClientInformation,
	StoredOAuthTokens,
} from "@modelcontextprotocol/client";

export interface McpSecretValue {
	clientSecret?: string;
	bearerToken?: string;
	headers?: Record<string, string>;
	environment?: Record<string, string>;
	oauth?: McpOAuthSecret;
}

export interface McpOAuthSecret {
	latestIssuer?: string;
	clients: Record<string, StoredOAuthClientInformation>;
	tokens: Record<string, StoredOAuthTokens>;
	codeVerifier?: string;
	discoveryState?: OAuthDiscoveryState;
	resourceUrl?: string;
}

export interface McpSecretResolver {
	getSecret(reference: string): Promise<McpSecretValue | undefined>;
}

export interface McpSecretWriter extends McpSecretResolver {
	setSecret(reference: string, value: McpSecretValue): Promise<void>;
}

export interface McpOAuthProviderResolver {
	getOAuthProvider(connection: McpConnection): Promise<OAuthClientProvider>;
}
