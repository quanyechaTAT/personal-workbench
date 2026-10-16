import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Model } from "../src/types.ts";
import { getOpenRouterSonnetTestModel, getXiaomiTestModel, XIAOMI_TEST_PROVIDERS } from "./catalog-test-models.ts";

const catalog = vi.hoisted(() => ({ models: [] as Model<"openai-completions">[] }));
vi.mock("../src/compat.ts", () => ({ getModels: () => catalog.models }));

const baseModel = {
	api: "openai-completions",
	provider: "xiaomi",
	baseUrl: "https://example.test/v1",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 8192,
} satisfies Omit<Model<"openai-completions">, "id" | "name">;

beforeEach(() => {
	catalog.models = [];
});

describe("catalog integration test model selection", () => {
	it.each(["2.5", "2.6"])("selects a MiMo Pro model after catalog rotation to %s", (version) => {
		const pro = { ...baseModel, id: `mimo-v${version}-pro`, name: "MiMo Pro" };
		catalog.models = [
			{ ...pro, id: `mimo-v${version}-flash` },
			{ ...pro, id: `mimo-v${version}-pro-ultraspeed` },
			pro,
		];
		for (const provider of XIAOMI_TEST_PROVIDERS) expect(getXiaomiTestModel(provider)).toBe(pro);
	});

	it.each(["4.6", "5.5"])("selects a regular Sonnet model after catalog rotation to %s", (version) => {
		const sonnet = { ...baseModel, provider: "openrouter", id: `anthropic/claude-sonnet-${version}`, name: "Sonnet" };
		catalog.models = [
			{ ...sonnet, id: `${sonnet.id}:batch` },
			{ ...sonnet, id: "anthropic/claude-opus-4.7" },
			sonnet,
		];
		expect(getOpenRouterSonnetTestModel()).toBe(sonnet);
	});

	it("fails clearly when a catalog no longer has the required family", () => {
		expect(() => getXiaomiTestModel("xiaomi")).toThrow("No MiMo Pro model available");
		expect(() => getOpenRouterSonnetTestModel()).toThrow("No Claude Sonnet model available");
	});
});
