import type { RuntimeAuthInteraction, RuntimeAuthMethod, RuntimeAuthType } from "./auth.ts";

export type RuntimeThinkingLevel = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export const MODEL_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ModelThinkingLevel = (typeof MODEL_THINKING_LEVELS)[number];
/** null disables a level; an empty string enables it without sending an effort parameter. */
export type RuntimeThinkingLevelMap = Partial<Record<ModelThinkingLevel, string | null>>;
export type RuntimeApiFormat = "openai-completions" | "anthropic-messages" | "openai-responses";

export interface ConfiguredModel {
	modelId: string;
	name: string;
	enabled: boolean;
	reasoning: boolean;
	vision: boolean;
	contextWindow: number;
	maxTokens: number;
	thinkingPreset: "auto" | "deepseek";
	thinkingLevelMap?: RuntimeThinkingLevelMap;
}

export function defaultThinkingLevelMap(preset: ConfiguredModel["thinkingPreset"]): RuntimeThinkingLevelMap {
	return preset === "deepseek"
		? { off: "none", minimal: null, low: "low", medium: null, high: "high", xhigh: null, max: "max" }
		: { off: "", minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: null, max: null };
}

export interface ConfiguredModelProvider {
	id: string;
	name: string;
	source: "pi" | "custom";
	baseUrl: string;
	api: string;
	enabled: boolean;
	models: ConfiguredModel[];
}

export interface RuntimeProviderCatalog extends ConfiguredModelProvider {
	configured: boolean;
	/** A native default connection is available for manually defined model IDs. */
	supportsCustomModels?: boolean;
	authMethods?: RuntimeAuthMethod[];
}

export interface DiscoverModelsOptions {
	baseUrl: string;
	api: string;
	providerId?: string;
	apiKey?: string;
	modelsUrl?: string;
	signal?: AbortSignal;
}

export interface DiscoveredModel {
	modelId: string;
	name: string;
	ownedBy?: string;
	reasoning?: boolean;
	vision?: boolean;
	contextWindow?: number;
	maxTokens?: number;
	thinkingPreset?: ConfiguredModel["thinkingPreset"];
	metadataSource?: "provider" | "pi";
}

export interface DiscoveredModelCatalog {
	endpoint: string;
	models: DiscoveredModel[];
	warnings: string[];
}

/** Provider discovery and configuration belong to the adapter; credentials never reach UI DTOs. */
export interface RuntimeModelCatalog {
	providers(): Promise<RuntimeProviderCatalog[]>;
	apply(providers: ConfiguredModelProvider[], apiKeys: ReadonlyMap<string, string>): Promise<void>;
	discoverModels?(options: DiscoverModelsOptions): Promise<DiscoveredModelCatalog>;
	login?(providerId: string, type: RuntimeAuthType, interaction: RuntimeAuthInteraction): Promise<void>;
}
