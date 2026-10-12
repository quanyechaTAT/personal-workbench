export type RuntimeAuthType = "oauth" | "api_key";

export interface RuntimeAuthMethod {
	type: RuntimeAuthType;
	label: string;
}

export type RuntimeAuthPrompt =
	| { type: "text" | "secret" | "manual_code"; message: string; placeholder?: string }
	| { type: "select"; message: string; options: readonly { id: string; label: string; description?: string }[] };

export type RuntimeAuthEvent =
	| { type: "info"; message: string; links?: readonly { url: string; label?: string }[] }
	| { type: "auth_url"; url: string; instructions?: string }
	| {
			type: "device_code";
			userCode: string;
			verificationUri: string;
			intervalSeconds?: number;
			expiresInSeconds?: number;
	  }
	| { type: "progress"; message: string };

export interface RuntimeAuthInteraction {
	signal?: AbortSignal;
	prompt(prompt: RuntimeAuthPrompt & { signal?: AbortSignal }): Promise<string>;
	notify(event: RuntimeAuthEvent): void;
}

/** Login progress contains challenges only, never credentials or submitted answers. */
export interface ModelLoginState {
	id: string;
	providerId: string;
	authType: RuntimeAuthType;
	status: "running" | "waiting" | "succeeded" | "failed" | "cancelled";
	events: RuntimeAuthEvent[];
	prompt?: RuntimeAuthPrompt & { id: string };
	error?: string;
}
