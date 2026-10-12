import { type Api, getSupportedThinkingLevels, type Model } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
	type ConfiguredModel,
	type ConfiguredModelProvider,
	type DiscoveredModelCatalog,
	type DiscoverModelsOptions,
	defaultThinkingLevelMap,
	type RuntimeAuthInteraction,
	type RuntimeAuthMethod,
	type RuntimeAuthType,
	RuntimeError,
	type RuntimeModel,
	type RuntimeModelCatalog,
	type RuntimeProviderCatalog,
} from "@earendil-works/workbench-runtime";
import { discoverProviderModels } from "./provider-model-discovery.ts";

function deepseekModel(model: Pick<Model<Api>, "id" | "baseUrl">): boolean {
	return (
		/^deepseek-(?:flash|v4)/iu.test(model.id) ||
		(URL.canParse(model.baseUrl) && new URL(model.baseUrl).hostname === "api.deepseek.com")
	);
}

export function configuredModel(model: Model<Api>): ConfiguredModel {
	return {
		modelId: model.id,
		name: model.name,
		enabled: true,
		reasoning: model.reasoning,
		vision: model.input.includes("image"),
		contextWindow: model.contextWindow,
		maxTokens: model.maxTokens,
		thinkingPreset: deepseekModel(model) ? "deepseek" : "auto",
		thinkingLevelMap: model.thinkingLevelMap ? { ...model.thinkingLevelMap } : undefined,
	};
}

/** Workbench owns selected model definitions; Pi owns providers, connections and authentication. */
export class PiModelCatalog implements RuntimeModelCatalog {
	private readonly runtime: ModelRuntime;
	private readonly customIds = new Set<string>();
	private readonly providerNames = new Map<string, string>();
	private selected?: Map<string, Model<Api>>;

	constructor(runtime: ModelRuntime) {
		this.runtime = runtime;
	}

	async providers(): Promise<RuntimeProviderCatalog[]> {
		// Pi's CLI may update credentials or models.json while Workbench remains open.
		await this.runtime.refresh({ allowNetwork: false });
		return this.runtime
			.getProviders()
			.filter((provider) => !this.customIds.has(provider.id))
			.map((provider) => {
				const models = this.runtime.getModels(provider.id);
				const baseUrl = provider.baseUrl ?? models[0]?.baseUrl ?? "";
				const api = models[0]?.api ?? "openai-completions";
				const authMethods: RuntimeAuthMethod[] = [];
				if (provider.auth.oauth)
					authMethods.push({ type: "oauth", label: provider.auth.oauth.loginLabel ?? provider.auth.oauth.name });
				if (provider.auth.apiKey?.login) authMethods.push({ type: "api_key", label: provider.auth.apiKey.name });
				return {
					id: provider.id,
					name: provider.name,
					source: "pi",
					enabled: true,
					baseUrl,
					api,
					supportsCustomModels: models.some(
						(model) => model.api === api && model.baseUrl.replace(/\/+$/u, "") === baseUrl.replace(/\/+$/u, ""),
					),
					configured: this.runtime.hasConfiguredAuth(provider.id),
					authMethods,
					models: models.map(configuredModel),
				};
			});
	}

	async login(providerId: string, type: RuntimeAuthType, interaction: RuntimeAuthInteraction): Promise<void> {
		if (this.customIds.has(providerId))
			throw new RuntimeError("model_unavailable", "自定义供应商请使用 API Key 配置");
		await this.runtime.login(providerId, type, interaction);
	}

	async discoverModels(options: DiscoverModelsOptions): Promise<DiscoveredModelCatalog> {
		const key =
			options.apiKey ??
			(options.providerId ? (await this.runtime.getAuth(options.providerId))?.auth.apiKey : undefined);
		if (!key) throw new RuntimeError("model_unavailable", "请填写 API Key，或在模型设置中完成 Pi 登录");
		const result = await discoverProviderModels({ ...options, apiKey: key });
		const native = this.runtime.getModels().filter((model) => !this.customIds.has(model.provider));
		result.models = result.models.map((entry) => {
			const known = native.find(
				(model) => model.id === entry.modelId && (!entry.ownedBy || model.provider === entry.ownedBy),
			);
			if (!known) return entry;
			const defaults = configuredModel(known);
			return {
				...entry,
				reasoning: entry.reasoning ?? defaults.reasoning,
				vision: entry.vision ?? defaults.vision,
				contextWindow: entry.contextWindow ?? defaults.contextWindow,
				maxTokens: entry.maxTokens ?? defaults.maxTokens,
				thinkingPreset: entry.thinkingPreset ?? defaults.thinkingPreset,
				metadataSource: entry.metadataSource ?? "pi",
			};
		});
		if (
			result.models.some(
				(model) =>
					model.reasoning === undefined || model.contextWindow === undefined || model.maxTokens === undefined,
			)
		)
			result.warnings.push(
				"部分模型只返回 ID 或有限元数据。加入后请核对思考、视觉、上下文和输出上限；模型目录可列出模型，不代表当前账户一定有调用额度。",
			);
		return result;
	}

	async apply(providers: ConfiguredModelProvider[], apiKeys: ReadonlyMap<string, string>): Promise<void> {
		this.providerNames.clear();
		for (const provider of providers) this.providerNames.set(provider.id, provider.name);
		const active = new Map<string, Model<Api>>();
		const custom = new Set(
			providers.filter((provider) => provider.source === "custom").map((provider) => provider.id),
		);
		for (const id of this.customIds) {
			if (!custom.has(id)) {
				await this.runtime.removeRuntimeApiKey(id);
				this.runtime.unregisterProvider(id);
				this.customIds.delete(id);
			}
		}
		for (const provider of providers) {
			if (provider.source === "custom") {
				if (!provider.models.length) {
					await this.runtime.removeRuntimeApiKey(provider.id);
					this.runtime.unregisterProvider(provider.id);
					this.customIds.delete(provider.id);
					continue;
				}
				this.runtime.registerProvider(provider.id, {
					name: provider.name,
					baseUrl: provider.baseUrl,
					api: provider.api,
					models: provider.models.map((model) => ({
						id: model.modelId,
						name: model.name,
						reasoning: model.reasoning,
						input: model.vision ? ["text", "image"] : ["text"],
						contextWindow: model.contextWindow,
						maxTokens: model.maxTokens,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					})),
				});
				this.customIds.add(provider.id);
				const key = apiKeys.get(provider.id);
				if (key) await this.runtime.setRuntimeApiKey(provider.id, key);
				else await this.runtime.removeRuntimeApiKey(provider.id);
			}
			if (!provider.enabled) continue;
			for (const entry of provider.models.filter((model) => model.enabled)) {
				const original = this.runtime.getModel(provider.id, entry.modelId);
				const template =
					original ??
					this.runtime
						.getModels(provider.id)
						.find(
							(model) =>
								model.api === provider.api &&
								model.baseUrl.replace(/\/+$/u, "") === provider.baseUrl.replace(/\/+$/u, ""),
						);
				// Preserve saved definitions when a native directory is temporarily unavailable.
				// Settings must remain reachable to repair login or refresh the provider.
				if (!template) continue;
				const model: Model<Api> = {
					...template,
					id: entry.modelId,
					name: entry.name,
					reasoning: entry.reasoning,
					input: entry.vision ? ["text", "image"] : ["text"],
					contextWindow: entry.contextWindow,
					maxTokens: entry.maxTokens,
					cost: original?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					// A new ID has user-declared capabilities; don't inherit model-specific effort limits.
					thinkingLevelMap: original?.thinkingLevelMap,
					samplingParams: original?.samplingParams,
				};
				if (entry.thinkingPreset === "deepseek" && model.reasoning) {
					model.thinkingLevelMap = defaultThinkingLevelMap("deepseek");
					if (model.api === "openai-completions")
						model.compat = {
							...model.compat,
							thinkingFormat: "deepseek",
							supportsReasoningEffort: true,
							requiresReasoningContentOnAssistantMessages: true,
							supportsDeveloperRole: false,
							supportsStore: false,
							maxTokensField: "max_tokens",
						};
					if (model.api === "anthropic-messages") model.compat = { ...model.compat, forceAdaptiveThinking: true };
				}
				if (entry.thinkingLevelMap && model.reasoning)
					model.thinkingLevelMap = { ...model.thinkingLevelMap, ...entry.thinkingLevelMap };
				active.set(`${provider.id}/${entry.modelId}`, model);
			}
		}
		this.selected = active;
	}

	resolve(provider: string, modelId: string): Model<Api> {
		const model = this.selected
			? this.selected.get(`${provider}/${modelId}`)
			: this.runtime.getModel(provider, modelId);
		if (!model) throw new RuntimeError("model_unavailable", "该模型尚未添加或已停用，请在设置中添加并启用模型");
		return model;
	}

	/** Only an explicitly enabled official endpoint may supply a key to official search. */
	searchProvider(): string | undefined {
		return [...(this.selected?.values() ?? this.runtime.getModels())].find(
			(model) =>
				URL.canParse(model.baseUrl) &&
				new URL(model.baseUrl).origin === "https://api.deepseek.com" &&
				this.runtime.hasConfiguredAuth(model.provider),
		)?.provider;
	}

	get isManaged(): boolean {
		return this.selected !== undefined;
	}

	providerName(id: string): string {
		return this.providerNames.get(id) ?? this.runtime.getProvider(id)?.name ?? id;
	}

	listModels(): RuntimeModel[] {
		return [...(this.selected?.values() ?? this.runtime.getModels())].map((model) => ({
			provider: model.provider,
			providerName: this.providerName(model.provider),
			modelId: model.id,
			name: model.name,
			available: this.runtime.hasConfiguredAuth(model.provider),
			reasoning: model.reasoning,
			contextWindow: model.contextWindow,
			vision: model.input.includes("image"),
			maxTokens: model.maxTokens,
			thinkingLevels: getSupportedThinkingLevels(model).map((level) => (level === "off" ? "none" : level)),
		}));
	}
}
