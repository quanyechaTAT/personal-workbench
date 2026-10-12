import { describe, expect, test, vi } from "vitest";
import { PiWebSearch, parseSearchResult } from "../src/pi-web-search.ts";

const evidence = {
	content: [
		{
			type: "web_search_tool_result",
			content: [
				{
					type: "web_search_result",
					url: "https://api-docs.deepseek.com/guides/thinking_mode/",
					title: "Thinking",
					page_age: "2026-09-26",
				},
				{
					type: "web_search_result",
					url: "https://api-docs.deepseek.com/guides/thinking_mode/",
					title: "Duplicate",
				},
				{ type: "web_search_result", url: "javascript:alert(1)", title: "Unsafe" },
				{ type: "web_search_result", url: "https://other.example/search", title: "Other" },
			],
		},
		{
			type: "text",
			text: "Do not use the search model's prose as evidence",
			citations: [
				{
					url: "https://api-docs.deepseek.com/guides/thinking_mode/",
					cited_text: "Supports none, low, high and max.",
				},
			],
		},
	],
};

describe("native DeepSeek search", () => {
	test("uses the existing key at the official Messages endpoint and parses structured results", async () => {
		const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(evidence)));
		const search = new PiWebSearch(async () => "private-test-key", request);
		expect(await search.status()).toMatchObject({ configured: true, modelId: "deepseek-flash" });
		const result = await search.search({
			query: "DeepSeek thinking",
			allowed_domains: ["deepseek.com"],
			max_results: 1,
		});
		const [url, init] = request.mock.calls[0];
		expect(url).toBe("https://api.deepseek.com/anthropic/v1/messages");
		expect(init?.redirect).toBe("error");
		expect(new Headers(init?.headers).get("x-api-key")).toBe("private-test-key");
		const body: unknown = JSON.parse(String(init?.body));
		expect(body).toMatchObject({
			model: "deepseek-flash",
			tools: [{ type: "web_search_20250305", max_uses: 1, allowed_domains: ["deepseek.com"] }],
		});
		expect(result.results).toEqual([
			{
				title: "Thinking",
				url: "https://api-docs.deepseek.com/guides/thinking_mode/",
				snippet: "Supports none, low, high and max.",
				publishedAt: "2026-09-26",
			},
		]);
		expect(JSON.stringify(result)).not.toContain("private-test-key");
		expect(JSON.stringify(result)).not.toContain("model's prose");
	});
	test("deduplicates URLs, rejects unsafe URLs, and enforces domain exclusions", () => {
		expect(parseSearchResult(evidence, { query: "DeepSeek", blocked_domains: ["deepseek.com"] }).results).toEqual([
			{ title: "Other", url: "https://other.example/search", snippet: "", publishedAt: undefined },
		]);
	});
	test("fails when no native search was performed or the server tool returned an error", () => {
		expect(() =>
			parseSearchResult({ content: [{ type: "text", text: "A plausible answer" }] }, { query: "latest" }),
		).toThrow("没有执行原生联网搜索");
		expect(() =>
			parseSearchResult(
				{
					content: [
						{
							type: "web_search_tool_result",
							content: { type: "web_search_tool_result_error", error_code: "max_uses_exceeded" },
						},
					],
				},
				{ query: "latest" },
			),
		).toThrow("原生搜索工具返回错误");
	});
	test.each([401, 429, 500])("reports HTTP %s without returning upstream secrets", async (status) => {
		const search = new PiWebSearch(
			async () => "private-test-key",
			async () => new Response("private-test-key echoed", { status }),
		);
		await expect(search.search({ query: "latest" })).rejects.toThrow(`HTTP ${status}`);
	});
	test("cancels a pending HTTP search with the caller signal", async () => {
		const controller = new AbortController();
		let markDispatched: (() => void) | undefined;
		const dispatched = new Promise<void>((resolve) => {
			markDispatched = resolve;
		});
		const search = new PiWebSearch(
			async () => "key",
			async (_url, init) => {
				markDispatched?.();
				return new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
				});
			},
		);
		const result = search.search({ query: "latest" }, controller.signal);
		await dispatched;
		controller.abort(new Error("Stopped by user"));
		await expect(result).rejects.toThrow("Stopped by user");
	});
	test("does not dispatch when credentials are absent or cancellation happened during credential resolution", async () => {
		const request = vi.fn<typeof fetch>();
		await expect(new PiWebSearch(async () => undefined, request).search({ query: "latest" })).rejects.toThrow(
			"未配置",
		);
		const controller = new AbortController();
		await expect(
			new PiWebSearch(async () => {
				controller.abort(new Error("cancelled"));
				return "key";
			}, request).search({ query: "latest" }, controller.signal),
		).rejects.toThrow("cancelled");
		expect(request).not.toHaveBeenCalled();
	});
});
