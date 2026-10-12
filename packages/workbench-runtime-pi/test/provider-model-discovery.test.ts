import { createServer, type IncomingHttpHeaders } from "node:http";
import { afterEach, expect, test } from "vitest";
import { providerError } from "../src/provider-error.ts";
import { discoverProviderModels, modelListEndpoints, parseDiscoveredModels } from "../src/provider-model-discovery.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function catalogServer(
	reply: (
		url: URL,
		headers: IncomingHttpHeaders,
	) => { status?: number; body?: unknown; redirect?: string } | undefined,
) {
	const requests: Array<{ url: URL; headers: IncomingHttpHeaders }> = [];
	const server = createServer((request, response) => {
		const url = new URL(request.url ?? "/", "http://localhost");
		requests.push({ url, headers: request.headers });
		const value = reply(url, request.headers);
		if (!value) return;
		response.writeHead(value.status ?? 200, {
			"content-type": "application/json",
			...(value.redirect ? { location: value.redirect } : {}),
		});
		response.end(JSON.stringify(value.body ?? {}));
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("No model catalog address");
	cleanups.push(async () => {
		server.closeAllConnections();
		await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
	});
	return { origin: `http://127.0.0.1:${address.port}`, requests };
}

test("CC Switch style URL candidates preserve version paths and strip full or compatibility endpoints", () => {
	expect(modelListEndpoints("https://example.com/v1/")).toEqual(["https://example.com/v1/models"]);
	expect(modelListEndpoints("https://example.com/v4/responses")).toEqual([
		"https://example.com/v4/models",
		"https://example.com/v4/v1/models",
	]);
	expect(modelListEndpoints("https://example.com/v1/chat/completions")).toEqual(["https://example.com/v1/models"]);
	expect(modelListEndpoints("https://example.com/anthropic/")).toEqual([
		"https://example.com/anthropic/v1/models",
		"https://example.com/v1/models",
		"https://example.com/models",
	]);
	expect(modelListEndpoints("https://example.com", "https://example.com/custom/catalog")).toEqual([
		"https://example.com/custom/catalog",
	]);
});

test("parsing accepts known list envelopes, deduplicates IDs, and preserves declared DeepSeek capabilities", () => {
	const models = parseDiscoveredModels({
		data: [
			null,
			{},
			{ id: "" },
			{ id: "plain" },
			{
				id: "deepseek-flash",
				name: "DeepSeek Flash",
				context_window: 1000000,
				max_output_tokens: 384000,
				input_modalities: ["text", "image"],
				effort: { supported_levels: ["none", "low", "high", "max"] },
			},
			{ id: "plain" },
		],
		models: [{ id: "ignored" }],
	});
	expect(models.map((entry) => entry.modelId)).toEqual(["deepseek-flash", "plain"]);
	expect(models[0]).toMatchObject({
		name: "DeepSeek Flash",
		reasoning: true,
		vision: true,
		contextWindow: 1000000,
		maxTokens: 384000,
		thinkingPreset: "deepseek",
		metadataSource: "provider",
	});
	expect(models[1].reasoning).toBeUndefined();
	expect(parseDiscoveredModels({ models: [{ slug: "codex-model", id: "internal-id" }] })[0]?.modelId).toBe(
		"codex-model",
	);
	expect(parseDiscoveredModels({ data: [] })).toEqual([]);
	expect(() => parseDiscoveredModels({ data: [{ id: "\u0000" }] })).toThrow("合法的模型 ID");
	expect(() => parseDiscoveredModels({ message: "Not a model list" })).toThrow("格式无法识别");
});

test.each(["openai-completions", "openai-responses", "anthropic-messages"])(
	"%s uses the correct authentication and only falls back on 404/405",
	async (api) => {
		const server = await catalogServer((url) =>
			url.pathname === "/v1/models" ? { status: 404 } : { body: { data: [{ id: "remote-model" }] } },
		);
		const result = await discoverProviderModels({ baseUrl: server.origin, api, apiKey: "fixture-catalog-secret" });
		expect(result.endpoint).toBe(`${server.origin}/models`);
		expect(result.models[0]?.modelId).toBe("remote-model");
		expect(server.requests.map((entry) => entry.url.pathname)).toEqual(["/v1/models", "/models"]);
		for (const { headers } of server.requests) {
			if (api === "anthropic-messages") {
				expect(headers["x-api-key"]).toBe("fixture-catalog-secret");
				expect(headers["anthropic-version"]).toBe("2023-06-01");
				expect(headers.authorization).toBeUndefined();
			} else expect(headers.authorization).toBe("Bearer fixture-catalog-secret");
		}
	},
);

test.each([401, 403, 429, 500])(
	"HTTP %s stops discovery and does not expose the provider's echoed secret",
	async (status) => {
		const server = await catalogServer(() => ({ status, body: { error: { message: "fixture-sensitive-key" } } }));
		await expect(
			discoverProviderModels({ baseUrl: server.origin, api: "openai-responses", apiKey: "fixture-sensitive-key" }),
		).rejects.toThrow(`HTTP ${status}`);
		expect(server.requests).toHaveLength(1);
	},
);

test("Anthropic pagination includes every page and refuses a repeated cursor", async () => {
	const server = await catalogServer((url) => ({
		body: url.searchParams.has("after_id")
			? { data: [{ id: "model-b" }], has_more: false }
			: { data: [{ id: "model-a" }], has_more: true, last_id: "model-a" },
	}));
	const result = await discoverProviderModels({
		baseUrl: `${server.origin}/v1`,
		api: "anthropic-messages",
		apiKey: "fixture-page-key",
	});
	expect(result.models.map((entry) => entry.modelId)).toEqual(["model-a", "model-b"]);
	expect(server.requests[1]?.url.searchParams.get("after_id")).toBe("model-a");
	const invalid = await catalogServer(() => ({
		body: { data: [{ id: "repeat" }], has_more: true, last_id: "repeat" },
	}));
	await expect(
		discoverProviderModels({ baseUrl: invalid.origin, api: "anthropic-messages", apiKey: "fixture-page-key" }),
	).rejects.toThrow("分页无效");
	expect(invalid.requests).toHaveLength(2);
});

test("discovery does not forward credentials through redirects, and respects cancellation", async () => {
	const target = await catalogServer(() => ({ body: { data: [{ id: "unexpected" }] } }));
	const source = await catalogServer(() => ({ status: 302, redirect: `${target.origin}/models` }));
	await expect(
		discoverProviderModels({ baseUrl: source.origin, api: "openai-responses", apiKey: "fixture-redirect-key" }),
	).rejects.toThrow("无法连接");
	expect(target.requests).toHaveLength(0);
	const controller = new AbortController();
	const hanging = await catalogServer(() => {
		controller.abort();
		return undefined;
	});
	await expect(
		discoverProviderModels({
			baseUrl: hanging.origin,
			api: "openai-completions",
			apiKey: "fixture-key",
			signal: controller.signal,
		}),
	).rejects.toThrow("取消或超时");
});

test("provider failures explain quota and preserve plain text without internal provider IDs", () => {
	expect(
		providerError(
			'API error (402): {"error":{"message":"Daily quota exceeded","code":"daily_quota"}}',
			"wb-id",
			"aixhan",
		),
	).toBe("aixhan 请求失败（HTTP 402）：Daily quota exceeded");
	expect(providerError("API error (503): Please retry later", "wb-id", "DeepSeek")).toBe(
		"DeepSeek 请求失败（HTTP 503）：Please retry later",
	);
	expect(providerError("No API key for wb-id", "wb-id", "DeepSeek")).toBe("No API key for DeepSeek");
});
