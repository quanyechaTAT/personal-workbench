import { randomUUID } from "node:crypto";
import {
	type ConfiguredModelProvider,
	defaultThinkingLevelMap,
	MODEL_THINKING_LEVELS,
	type RuntimeModelCatalog,
	type RuntimeModelRef,
} from "@earendil-works/workbench-runtime";
import { type Static, Type } from "typebox";
import { Check } from "typebox/value";
import {
	ConfiguredModelSchema,
	type DiscoverModelsInput,
	type ModelSettingsDto,
	type SaveModelProviderInput,
} from "./contracts/models.ts";
import { WorkbenchError } from "./errors.ts";
import type { JsonValue } from "./models.ts";
import type { SettingsService } from "./settings-service.ts";

export interface ApiKeyStore {
	create(key: string): Promise<string>;
	get(reference: string): Promise<string | undefined>;
	delete(reference: string): Promise<void>;
}

const StoredProviders = Type.Array(
	Type.Object(
		{
			id: Type.String(),
			name: Type.String(),
			source: Type.Union([Type.Literal("pi"), Type.Literal("custom")]),
			baseUrl: Type.String(),
			api: Type.String(),
			enabled: Type.Boolean(),
			models: Type.Array(ConfiguredModelSchema),
			secretRef: Type.Optional(Type.String()),
		},
		{ additionalProperties: false },
	),
);
type StoredProvider = Static<typeof StoredProviders>[number];
const CONFIG_KEY = "models.catalog";

export class ModelSettingsService {
	private readonly settings: SettingsService;
	private readonly adapter?: RuntimeModelCatalog;
	private readonly secrets: ApiKeyStore;

	constructor(settings: SettingsService, adapter: RuntimeModelCatalog | undefined, secrets: ApiKeyStore) {
		this.settings = settings;
		this.adapter = adapter;
		this.secrets = secrets;
	}

	async initialize(references: RuntimeModelRef[]): Promise<void> {
		if (!this.adapter) return;
		if (!(await this.settings.get(CONFIG_KEY))) {
			const imported = (await this.adapter.providers())
				.filter((provider) => provider.configured)
				.map((provider) => {
					const used = provider.models.filter((model) =>
						references.some((ref) => ref.provider === provider.id && ref.modelId === model.modelId),
					);
					const {
						configured: _configured,
						authMethods: _authMethods,
						supportsCustomModels: _customModels,
						...configuration
					} = provider;
					return { ...configuration, models: used.length ? used : provider.models.slice(0, 1) };
				});
			await this.settings.set(
				CONFIG_KEY,
				imported.map((provider) => ({ ...provider, models: provider.models.map((model) => ({ ...model })) })),
			);
		}
		await this.apply((await this.read()).providers);
	}

	async get(): Promise<ModelSettingsDto> {
		const current = await this.read();
		const native = (await this.adapter?.providers()) ?? [];
		return {
			version: current.version,
			providers: await Promise.all(
				current.providers.map(async ({ secretRef, ...provider }) => ({
					...provider,
					supportsCustomModels:
						provider.source === "pi"
							? native.find((entry) => entry.id === provider.id)?.supportsCustomModels
							: undefined,
					configured:
						provider.source === "pi"
							? native.some((entry) => entry.id === provider.id && entry.configured)
							: Boolean(secretRef && (await this.secrets.get(secretRef))),
				})),
			),
		};
	}

	candidates() {
		return this.adapter?.providers() ?? Promise.resolve([]);
	}

	async discover(input: DiscoverModelsInput, signal?: AbortSignal) {
		if (!this.adapter?.discoverModels) throw new WorkbenchError("conflict", "当前运行时不支持获取供应商模型列表");
		validateModelEndpoint(input.baseUrl);
		if (input.modelsUrl) {
			validateModelEndpoint(input.modelsUrl);
			if (new URL(input.modelsUrl).origin !== new URL(input.baseUrl).origin)
				throw new WorkbenchError("invalid_input", "模型列表地址必须与 Base URL 同源，以保护供应商凭证");
		}
		const stored = (await this.read()).providers.find((provider) => provider.id === input.providerId);
		if (input.providerId && !stored) throw new WorkbenchError("not_found", "供应商不存在");
		if (stored?.source === "pi" && !input.modelsUrl && !input.apiKey) {
			if (stored.baseUrl.replace(/\/+$/u, "") !== input.baseUrl.replace(/\/+$/u, "") || stored.api !== input.api)
				throw new WorkbenchError("invalid_input", "Pi 供应商沿用 Pi 的连接地址和 API 格式");
			const native = (await this.candidates()).find((provider) => provider.id === stored.id);
			if (!native?.configured) throw new WorkbenchError("invalid_input", "请先在模型设置中完成该供应商的 Pi 登录");
			return {
				endpoint: "Pi 模型目录",
				models: native.models.map((model) => ({ ...model, metadataSource: "pi" as const })),
				warnings: [] as string[],
			};
		}
		if (!["openai-completions", "anthropic-messages", "openai-responses"].includes(input.api))
			throw new WorkbenchError("invalid_input", "该 API 格式暂不支持远程模型列表，可使用 Pi 模型目录");
		let key = input.apiKey?.trim();
		if (key && /[\r\n\u0000]/u.test(key)) throw new WorkbenchError("invalid_input", "API Key 格式无效");
		if (stored && !key) {
			if (stored.baseUrl.replace(/\/+$/u, "") !== input.baseUrl.replace(/\/+$/u, "") || stored.api !== input.api)
				throw new WorkbenchError("invalid_input", "更换地址或 API 格式后，请重新填写 API Key，再获取模型列表");
			key = stored.secretRef ? await this.secrets.get(stored.secretRef) : undefined;
		}
		return this.adapter.discoverModels({
			...input,
			apiKey: key,
			providerId: stored?.source === "pi" ? stored.id : undefined,
			signal,
		});
	}

	async importProvider(providerId: string, expectedVersion: number): Promise<ModelSettingsDto> {
		const current = await this.read();
		this.checkVersion(current.version, expectedVersion);
		if (current.providers.some((provider) => provider.id === providerId))
			throw new WorkbenchError("conflict", "该供应商已经添加");
		const native = (await this.candidates()).find((provider) => provider.id === providerId && provider.configured);
		if (!native) throw new WorkbenchError("invalid_input", "请先完成该供应商的 Pi 登录，或选择添加自定义供应商");
		const {
			configured: _configured,
			authMethods: _authMethods,
			supportsCustomModels: _customModels,
			...provider
		} = native;
		return this.commit([...current.providers, { ...provider, models: [] }], current.version);
	}

	async save(id: string | undefined, input: SaveModelProviderInput): Promise<ModelSettingsDto> {
		if (!this.adapter) throw new WorkbenchError("conflict", "当前运行时不支持供应商设置");
		const current = await this.read();
		this.checkVersion(current.version, input.expectedVersion);
		const previous = current.providers.find((provider) => provider.id === id);
		if (id && !previous) throw new WorkbenchError("not_found", "供应商不存在");
		if (
			!input.name.trim() ||
			!input.models.every(
				(model) => model.modelId.trim() && model.name.trim() && model.maxTokens <= model.contextWindow,
			)
		)
			throw new WorkbenchError("invalid_input", "请检查供应商名称、模型 ID 和上下文/输出上限");
		if (new Set(input.models.map((model) => model.modelId.trim())).size !== input.models.length)
			throw new WorkbenchError("invalid_input", "模型 ID 不能重复");
		for (const model of input.models) {
			if (!model.thinkingLevelMap) continue;
			const map = { ...defaultThinkingLevelMap(model.thinkingPreset), ...model.thinkingLevelMap };
			if (model.reasoning && MODEL_THINKING_LEVELS.every((level) => map[level] === null))
				throw new WorkbenchError("invalid_input", "支持思考的模型至少需要启用一个思考档位");
			if (Object.values(map).some((value) => typeof value === "string" && /[\r\n\u0000-\u001f]/u.test(value)))
				throw new WorkbenchError("invalid_input", "思考参数不能包含换行或控制字符");
		}
		let next: StoredProvider = {
			id: previous?.id ?? `wb-${randomUUID()}`,
			source: previous?.source ?? "custom",
			name: input.name.trim(),
			baseUrl: input.baseUrl.trim().replace(/\/+$/u, ""),
			api: input.api,
			enabled: input.enabled,
			models: input.models.map((model) => ({ ...model, modelId: model.modelId.trim(), name: model.name.trim() })),
			secretRef: previous?.secretRef,
		};
		if (next.source === "pi") {
			if (input.apiKey || input.baseUrl !== previous?.baseUrl || input.api !== previous.api)
				throw new WorkbenchError("invalid_input", "Pi 供应商沿用 Pi 凭证和连接地址；更换地址请添加自定义供应商");
			const catalog = (await this.candidates()).find((provider) => provider.id === id);
			if (!catalog) throw new WorkbenchError("invalid_input", "Pi 供应商已不可用");
			next = {
				...next,
				models: next.models.map((entry) => {
					if (catalog.supportsCustomModels) return entry;
					const known = catalog.models.find((model) => model.modelId === entry.modelId);
					if (!known) throw new WorkbenchError("invalid_input", `Pi 目录中没有模型 ${entry.modelId}`);
					return {
						...known,
						enabled: entry.enabled,
						thinkingLevelMap: entry.thinkingLevelMap ?? known.thinkingLevelMap,
					};
				}),
			};
		} else {
			validateModelEndpoint(next.baseUrl);
			if (!["openai-completions", "anthropic-messages", "openai-responses"].includes(next.api))
				throw new WorkbenchError("invalid_input", "不支持的 API 格式");
			if (previous && previous.baseUrl !== next.baseUrl && !input.apiKey)
				throw new WorkbenchError("invalid_input", "更换 Base URL 时请重新填写 API Key，确认新地址可以接收该凭证");
		}
		let createdSecret: string | undefined;
		if (input.apiKey) {
			if (!input.apiKey.trim() || /[\r\n\u0000]/u.test(input.apiKey))
				throw new WorkbenchError("invalid_input", "API Key 格式无效");
			createdSecret = await this.secrets.create(input.apiKey.trim());
			next.secretRef = createdSecret;
		}
		try {
			const saved = await this.commit(
				[...current.providers.filter((provider) => provider.id !== id), next],
				current.version,
			);
			if (createdSecret && previous?.secretRef) await this.secrets.delete(previous.secretRef);
			return saved;
		} catch (error) {
			// Keep a referenced secret if persistence succeeded but a later operation failed.
			if (createdSecret && !(await this.read()).providers.some((provider) => provider.secretRef === createdSecret))
				await this.secrets.delete(createdSecret);
			throw error;
		}
	}

	async remove(id: string, expectedVersion: number): Promise<ModelSettingsDto> {
		const current = await this.read();
		this.checkVersion(current.version, expectedVersion);
		const removed = current.providers.find((provider) => provider.id === id);
		if (!removed) throw new WorkbenchError("not_found", "供应商不存在");
		const saved = await this.commit(
			current.providers.filter((provider) => provider.id !== id),
			current.version,
		);
		if (removed.secretRef) await this.secrets.delete(removed.secretRef);
		return saved;
	}

	private async read() {
		const record = await this.settings.get(CONFIG_KEY);
		if (!record) return { version: 0, providers: [] as StoredProvider[] };
		if (!Check(StoredProviders, record.value)) throw new WorkbenchError("storage_failure", "模型配置损坏，无法读取");
		return { version: record.version, providers: record.value };
	}

	private async commit(providers: StoredProvider[], version: number): Promise<ModelSettingsDto> {
		const previous = await this.read();
		try {
			await this.apply(providers);
			await this.settings.set(CONFIG_KEY, providers as JsonValue, version || undefined);
		} catch (error) {
			await this.apply(previous.providers);
			throw error;
		}
		return this.get();
	}

	private async apply(providers: StoredProvider[]): Promise<void> {
		const keys = new Map<string, string>();
		for (const provider of providers) {
			const value = provider.secretRef ? await this.secrets.get(provider.secretRef) : undefined;
			if (value) keys.set(provider.id, value);
		}
		const configurations: ConfiguredModelProvider[] = providers.map(
			({ secretRef: _secretRef, ...provider }) => provider,
		);
		await this.adapter?.apply(configurations, keys);
	}

	private checkVersion(actual: number, expected: number): void {
		if (actual !== expected) throw new WorkbenchError("conflict", "模型设置已变化，请刷新后重试");
	}
}

function validateModelEndpoint(value: string): void {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new WorkbenchError("invalid_input", "Base URL 必须为完整 HTTP(S) 地址");
	}
	if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash)
		throw new WorkbenchError("invalid_input", "Base URL 不允许凭证、查询参数或片段");
	if (url.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
		throw new WorkbenchError("invalid_input", "远程模型地址必须使用 HTTPS，本机服务可使用 HTTP");
}
