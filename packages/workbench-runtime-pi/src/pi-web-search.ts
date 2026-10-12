import {
	RuntimeError,
	type RuntimeWebSearch,
	type WebSearchInput,
	type WebSearchResult,
} from "@earendil-works/workbench-runtime";

const ENDPOINT = "https://api.deepseek.com/anthropic/v1/messages";
const MODEL = "deepseek-flash";

/** Native DeepSeek search uses a separate Messages call; only structured search evidence is returned. */
export class PiWebSearch implements RuntimeWebSearch {
	private readonly key: () => Promise<string | undefined>;
	private readonly request: typeof fetch;
	constructor(key: () => Promise<string | undefined>, request: typeof fetch = fetch) {
		this.key = key;
		this.request = request;
	}
	async status() {
		return { configured: Boolean(await this.key()), provider: "deepseek", modelId: MODEL, endpoint: ENDPOINT };
	}
	async search(input: WebSearchInput, signal?: AbortSignal): Promise<WebSearchResult> {
		signal?.throwIfAborted();
		const apiKey = await this.key();
		signal?.throwIfAborted();
		if (!apiKey) throw new RuntimeError("model_unavailable", "未配置 DeepSeek 官方 API Key，无法联网搜索");
		const requestSignal = AbortSignal.any([AbortSignal.timeout(90_000), ...(signal ? [signal] : [])]);
		try {
			const response = await this.request(ENDPOINT, {
				method: "POST",
				redirect: "error",
				signal: requestSignal,
				headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
				body: JSON.stringify({
					model: MODEL,
					max_tokens: 4096,
					messages: [
						{ role: "user", content: `请使用 web_search 搜索以下查询，简要回答并保留来源引用：${input.query}` },
					],
					tools: [
						{
							type: "web_search_20250305",
							name: "web_search",
							max_uses: 1,
							...(input.allowed_domains?.length ? { allowed_domains: input.allowed_domains } : {}),
							...(input.blocked_domains?.length ? { blocked_domains: input.blocked_domains } : {}),
						},
					],
				}),
			});
			if (!response.ok) {
				await response.body?.cancel();
				throw new RuntimeError(
					"runtime_failure",
					`DeepSeek 联网搜索返回 HTTP ${response.status}${response.status === 401 ? "，请检查 DeepSeek 凭证" : response.status === 429 ? "，请检查额度或稍后重试" : ""}`,
				);
			}
			const payload: unknown = JSON.parse(await limitedBody(response));
			return parseSearchResult(payload, input);
		} catch (error) {
			signal?.throwIfAborted();
			if (error instanceof RuntimeError) throw error;
			throw new RuntimeError(
				"runtime_failure",
				requestSignal.aborted ? "DeepSeek 联网搜索超时" : "DeepSeek 联网搜索连接失败或响应格式无效",
			);
		}
	}
}

export function parseSearchResult(payload: unknown, input: WebSearchInput): WebSearchResult {
	const content = object(payload)?.content;
	if (!Array.isArray(content)) throw new RuntimeError("runtime_failure", "DeepSeek 搜索响应缺少内容");
	const blocks = content.map(object).filter((item) => item !== undefined);
	const results: WebSearchResult["results"] = [];
	const snippets = new Map<string, string>();
	for (const block of blocks) {
		if (block.type !== "text" || !Array.isArray(block.citations)) continue;
		for (const value of block.citations) {
			const citation = object(value);
			if (typeof citation?.url === "string" && typeof citation.cited_text === "string")
				snippets.set(citation.url, citation.cited_text.slice(0, 2000));
		}
	}
	const searches = blocks.filter((block) => block.type === "web_search_tool_result");
	if (!searches.length)
		throw new RuntimeError(
			"runtime_failure",
			"DeepSeek 没有执行原生联网搜索，本次回答不能作为搜索结果。请稍后重试。",
		);
	const seen = new Set<string>();
	for (const search of searches) {
		if (!Array.isArray(search.content))
			throw new RuntimeError("runtime_failure", "DeepSeek 原生搜索工具返回错误，未取得搜索结果");
		for (const value of search.content) {
			const item = object(value);
			if (item?.type !== "web_search_result" || typeof item.url !== "string") continue;
			let url: URL;
			try {
				url = new URL(item.url);
			} catch {
				continue;
			}
			if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || seen.has(url.href))
				continue;
			const matches = (domain: string) => url.hostname === domain || url.hostname.endsWith(`.${domain}`);
			if (
				(input.allowed_domains?.length && !input.allowed_domains.some(matches)) ||
				input.blocked_domains?.some(matches)
			)
				continue;
			seen.add(url.href);
			results.push({
				title: typeof item.title === "string" ? item.title.slice(0, 300) : url.hostname,
				url: url.href,
				snippet: snippets.get(item.url) ?? "",
				publishedAt: typeof item.page_age === "string" ? item.page_age.slice(0, 80) : undefined,
			});
		}
	}
	return {
		kind: "web_search",
		query: input.query,
		provider: "deepseek",
		searchedAt: new Date().toISOString(),
		results: results.slice(0, input.max_results ?? 5),
	};
}

function object(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

async function limitedBody(response: Response): Promise<string> {
	if (!response.body) throw new RuntimeError("runtime_failure", "搜索返回空响应");
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let bytes = 0;
	try {
		while (true) {
			const part = await reader.read();
			if (part.done) break;
			bytes += part.value.byteLength;
			if (bytes > 2 * 1024 * 1024) {
				await reader.cancel();
				throw new RuntimeError("runtime_failure", "搜索响应过大，请缩小查询范围");
			}
			chunks.push(part.value);
		}
	} finally {
		reader.releaseLock();
	}
	return Buffer.concat(chunks).toString("utf8");
}
