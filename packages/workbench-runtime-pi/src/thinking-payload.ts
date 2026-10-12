import type { Api, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";

export function adaptThinkingPayload(
	payload: unknown,
	model: Model<Api> | undefined,
	level: ModelThinkingLevel,
): unknown {
	if (!model || typeof payload !== "object" || payload === null || Array.isArray(payload)) return undefined;
	const result: Record<string, unknown> = { ...payload };
	let changed = false;
	const compat = model.compat;
	if (
		model.api === "anthropic-messages" &&
		compat &&
		"forceAdaptiveThinking" in compat &&
		compat.forceAdaptiveThinking &&
		(model.thinkingLevelMap?.off === "none" || /^deepseek-/iu.test(model.id))
	) {
		const thinking = result.thinking;
		if (typeof thinking === "object" && thinking !== null && "type" in thinking && thinking.type === "adaptive") {
			result.thinking = { type: "enabled" };
			changed = true;
		}
	}
	if (model.thinkingLevelMap?.[level] === "") {
		if (model.api === "openai-completions") {
			delete result.reasoning_effort;
			changed = true;
		} else if (model.api === "openai-responses" || model.api === "anthropic-messages") {
			const key = model.api === "openai-responses" ? "reasoning" : "output_config";
			const value = result[key];
			if (typeof value === "object" && value !== null && !Array.isArray(value)) {
				const rest: Record<string, unknown> = { ...value };
				delete rest.effort;
				if (Object.keys(rest).length) result[key] = rest;
				else delete result[key];
				changed = true;
			}
		}
	}
	return changed ? result : undefined;
}
