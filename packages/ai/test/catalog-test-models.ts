import { getModels } from "../src/compat.ts";

export const XIAOMI_TEST_PROVIDERS = [
	"xiaomi",
	"xiaomi-token-plan-cn",
	"xiaomi-token-plan-ams",
	"xiaomi-token-plan-sgp",
] as const;

// Hydration uses the live catalog, so integration tests select a current family member.
export function getXiaomiTestModel(provider: (typeof XIAOMI_TEST_PROVIDERS)[number]) {
	const model = getModels(provider).find((candidate) => /^mimo-v[\d.]+-pro$/u.test(candidate.id));
	if (!model) throw new Error(`No MiMo Pro model available through ${provider}`);
	return model;
}

export function getOpenRouterSonnetTestModel() {
	const model = getModels("openrouter").find(
		(candidate) => candidate.id.startsWith("anthropic/claude-sonnet-") && !candidate.id.includes(":"),
	);
	if (!model) throw new Error("No Claude Sonnet model available through OpenRouter");
	return model;
}
