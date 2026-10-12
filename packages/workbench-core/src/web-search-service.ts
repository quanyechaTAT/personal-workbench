import type { RuntimeWebSearch, WebSearchInput, WebSearchResult } from "@earendil-works/workbench-runtime";
import { Check } from "typebox/value";
import { type SaveSearchSettingsInput, type SearchSettingsDto, WebSearchSchema } from "./contracts/web-search.ts";
import { WorkbenchError } from "./errors.ts";
import type { SettingsService } from "./settings-service.ts";

export class WebSearchService {
	private readonly settings: SettingsService;
	private readonly client?: RuntimeWebSearch;
	constructor(settings: SettingsService, client?: RuntimeWebSearch) {
		this.settings = settings;
		this.client = client;
	}
	async getSettings(): Promise<SearchSettingsDto> {
		const record = await this.settings.get("search.enabled");
		const status = await this.client?.status();
		return {
			enabled: record?.value !== false,
			version: record?.version ?? 0,
			provider: status?.provider ?? "deepseek",
			modelId: status?.modelId ?? "deepseek-flash",
			endpoint: status?.endpoint ?? "https://api.deepseek.com/anthropic/v1/messages",
			configured: status?.configured ?? false,
		};
	}
	async saveSettings(input: SaveSearchSettingsInput): Promise<SearchSettingsDto> {
		const current = await this.getSettings();
		if (input.expectedVersion !== current.version)
			throw new WorkbenchError("conflict", "搜索设置已变化，请刷新后重试");
		await this.settings.set("search.enabled", input.enabled, current.version || undefined);
		return this.getSettings();
	}
	async search(input: WebSearchInput, signal?: AbortSignal): Promise<WebSearchResult> {
		signal?.throwIfAborted();
		if (!Check(WebSearchSchema, input) || input.query.trim().length < 2)
			throw new WorkbenchError("invalid_input", "搜索词长度须为 2–512 字符，结果数量须为 1–10");
		if (input.allowed_domains?.length && input.blocked_domains?.length)
			throw new WorkbenchError("invalid_input", "allowed_domains 和 blocked_domains 不能同时使用");
		const normalized = {
			...input,
			query: input.query.trim(),
			allowed_domains: normalizeDomains(input.allowed_domains),
			blocked_domains: normalizeDomains(input.blocked_domains),
		};
		const configuration = await this.getSettings();
		if (!configuration.enabled) throw new WorkbenchError("conflict", "联网搜索已停用，请在设置 → 联网搜索启用");
		if (!this.client || !configuration.configured)
			throw new WorkbenchError(
				"conflict",
				"联网搜索需要 DeepSeek 官方 API 凭证。请在 Pi /login 登录 DeepSeek，或在模型设置添加 api.deepseek.com 供应商。",
			);
		return this.client.search(normalized, signal);
	}
}
function normalizeDomains(values?: string[]): string[] | undefined {
	return values?.map((value) => {
		const domain = value.trim().toLowerCase().replace(/\.$/u, "");
		if (!/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/u.test(domain))
			throw new WorkbenchError("invalid_input", "域名筛选须使用域名，例如 example.com，不能包含协议、路径或端口");
		return domain;
	});
}
