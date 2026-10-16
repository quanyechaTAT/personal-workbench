import { describe, expect, it } from "vitest";
import { getModels } from "../src/compat.ts";
import { getXiaomiTestModel } from "./catalog-test-models.ts";

const XIAOMI_PROVIDERS = ["xiaomi", "xiaomi-token-plan-cn", "xiaomi-token-plan-ams", "xiaomi-token-plan-sgp"] as const;
const DEPRECATED_MODEL_IDS = ["mimo-v2-flash", "mimo-v2-omni", "mimo-v2-pro"] as const;

describe("Xiaomi MiMo models", () => {
	it.each(XIAOMI_PROVIDERS)("omits deprecated models from %s", (provider) => {
		const modelIds = getModels(provider).map((model) => model.id);
		for (const modelId of DEPRECATED_MODEL_IDS) expect(modelIds).not.toContain(modelId);
	});

	it.each(XIAOMI_PROVIDERS)("keeps a current Pro model on %s", (provider) => {
		const model = getXiaomiTestModel(provider);
		expect(model).toMatchObject({ provider, api: "openai-completions", reasoning: true });
		expect(model.input).toContain("image");
	});
});
