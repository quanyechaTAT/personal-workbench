import {
	type DiscoveredModel,
	type DiscoveredModelCatalog,
	type DiscoverModelsOptions,
	RuntimeError,
} from "@earendil-works/workbench-runtime";

const COMPAT_PATHS = [
	"/api/claudecode",
	"/api/anthropic",
	"/apps/anthropic",
	"/api/coding",
	"/claudecode",
	"/anthropic",
	"/step_plan",
	"/coding",
	"/claude",
];
const MAX_BODY_BYTES = 5 * 1024 * 1024;

/** Candidate strategy follows CC Switch's model_fetch service; keep all requests on the supplied origin. */
export function modelListEndpoints(baseUrl: string, override?: string): string[] {
	const base = new URL(baseUrl);
	if (override) return [new URL(override).href];
	let path = base.pathname.replace(/\/+$/u, "");
	path = path.replace(/\/(?:chat\/completions|responses|messages)$/u, "");
	const candidates = [/\/v\d+$/u.test(path) ? `${path}/models` : `${path}/v1/models`];
	if (/\/v\d+$/u.test(path) && !path.endsWith("/v1")) candidates.push(`${path}/v1/models`);
	const suffix = COMPAT_PATHS.find((entry) => path.endsWith(entry));
	if (suffix) {
		const root = path.slice(0, -suffix.length);
		candidates.push(`${root}/v1/models`, `${root}/models`);
	} else if (!/\/v\d+$/u.test(path)) candidates.push(`${path}/models`);
	return [...new Set(candidates.map((candidate) => new URL(candidate, base.origin).href))];
}

function record(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function positive(value: unknown, min: number, max: number): number | undefined {
	return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max ? value : undefined;
}

export function parseDiscoveredModels(value: unknown): DiscoveredModel[] {
	const body = record(value);
	const catalogEnvelope = !Array.isArray(body?.data) && Array.isArray(body?.models);
	const entries = Array.isArray(body?.data)
		? body.data
		: Array.isArray(body?.models)
			? body.models
			: Array.isArray(value)
				? value
				: undefined;
	if (!entries) throw new RuntimeError("model_unavailable", "供应商返回的模型列表格式无法识别，仍可手动添加模型");
	const models = new Map<string, DiscoveredModel>();
	for (const value of entries) {
		const entry = record(value);
		const id = (catalogEnvelope ? [entry?.slug, entry?.id] : [entry?.id, entry?.slug]).find(
			(value) => typeof value === "string" && value.trim(),
		);
		if (typeof id !== "string" || !id.trim() || id.length > 200 || /[\u0000-\u001f]/u.test(id)) continue;
		const effort = record(entry?.effort);
		const capabilities = record(entry?.capabilities);
		const reasoning =
			typeof entry?.reasoning === "boolean"
				? entry.reasoning
				: typeof capabilities?.reasoning === "boolean"
					? capabilities.reasoning
					: Array.isArray(effort?.supported_levels)
						? effort.supported_levels.length > 0
						: undefined;
		const input = entry?.input_modalities ?? entry?.input;
		models.set(id, {
			modelId: id,
			name:
				typeof entry?.name === "string" && entry.name.trim()
					? entry.name.trim().slice(0, 200)
					: typeof entry?.display_name === "string" && entry.display_name.trim()
						? entry.display_name.trim().slice(0, 200)
						: id,
			ownedBy: typeof entry?.owned_by === "string" ? entry.owned_by.slice(0, 200) : undefined,
			reasoning,
			vision: Array.isArray(input) ? input.includes("image") : undefined,
			contextWindow: positive(entry?.context_window ?? entry?.context_length, 1024, 10000000),
			maxTokens: positive(
				entry?.max_output_tokens ?? record(entry?.top_provider)?.max_completion_tokens,
				128,
				1000000,
			),
			thinkingPreset: reasoning && /^deepseek-(?:flash|v4)/iu.test(id) ? "deepseek" : undefined,
			metadataSource:
				reasoning !== undefined || input !== undefined || entry?.context_window !== undefined
					? "provider"
					: undefined,
		});
	}
	if (entries.length && !models.size)
		throw new RuntimeError("model_unavailable", "模型列表没有合法的模型 ID，请检查供应商接口");
	return [...models.values()].sort((left, right) => left.modelId.localeCompare(right.modelId));
}

async function json(response: Response): Promise<unknown> {
	const reader = response.body?.getReader();
	if (!reader) throw new RuntimeError("model_unavailable", "模型列表响应为空");
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		while (true) {
			const chunk = await reader.read();
			if (chunk.done) break;
			size += chunk.value.byteLength;
			if (size > MAX_BODY_BYTES)
				throw new RuntimeError("model_unavailable", "模型列表超过 5 MiB，请使用更小的模型目录");
			chunks.push(chunk.value);
		}
		return JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} finally {
		await reader.cancel();
	}
}

export async function discoverProviderModels(
	options: DiscoverModelsOptions & { apiKey: string },
): Promise<DiscoveredModelCatalog> {
	const signal = options.signal
		? AbortSignal.any([options.signal, AbortSignal.timeout(15000)])
		: AbortSignal.timeout(15000);
	const headers: Record<string, string> = { accept: "application/json" };
	if (options.api === "anthropic-messages") {
		headers["x-api-key"] = options.apiKey;
		headers["anthropic-version"] = "2023-06-01";
	} else headers.authorization = `Bearer ${options.apiKey}`;
	try {
		for (const endpoint of modelListEndpoints(options.baseUrl, options.modelsUrl)) {
			const response = await fetch(endpoint, { headers, signal, redirect: "error" });
			if (response.status === 404 || response.status === 405) {
				await response.body?.cancel();
				continue;
			}
			if (!response.ok) {
				await response.body?.cancel();
				const reason =
					response.status === 401 || response.status === 403
						? "凭证无效或没有获取模型列表的权限"
						: response.status === 429
							? "请求过于频繁，请稍后重试"
							: "供应商暂时无法返回模型列表";
				throw new RuntimeError("model_unavailable", `${reason}（HTTP ${response.status}）`);
			}
			let body = await json(response);
			const models = new Map(parseDiscoveredModels(body).map((model) => [model.modelId, model]));
			const cursors = new Set<string>();
			while (record(body)?.has_more === true) {
				const cursor = record(body)?.last_id;
				if (typeof cursor !== "string" || cursors.has(cursor) || cursors.size >= 20)
					throw new RuntimeError("model_unavailable", "模型目录分页无效或页数过多");
				cursors.add(cursor);
				const next = new URL(endpoint);
				next.searchParams.set("after_id", cursor);
				const page = await fetch(next, { headers, signal, redirect: "error" });
				if (!page.ok) {
					await page.body?.cancel();
					throw new RuntimeError("model_unavailable", `模型目录分页获取失败（HTTP ${page.status}）`);
				}
				body = await json(page);
				for (const model of parseDiscoveredModels(body)) models.set(model.modelId, model);
			}
			return {
				endpoint,
				models: [...models.values()].sort((left, right) => left.modelId.localeCompare(right.modelId)),
				warnings: [],
			};
		}
		throw new RuntimeError(
			"model_unavailable",
			"未找到可用的模型列表接口（404/405）。请检查 Base URL，或填写同一供应商的模型列表地址；仍可手动添加模型。",
		);
	} catch (error) {
		if (error instanceof RuntimeError) throw error;
		throw new RuntimeError(
			"model_unavailable",
			signal.aborted
				? "获取模型列表已取消或超时（15 秒）"
				: "无法连接模型列表接口，或供应商返回了无效 JSON。请检查网络和地址。",
		);
	}
}
