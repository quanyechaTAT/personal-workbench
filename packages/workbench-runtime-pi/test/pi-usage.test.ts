import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { expect, test } from "vitest";
import { deriveSessionUsage, STEP_TIMING_ENTRY, TURN_USAGE_ENTRY } from "../src/pi-usage.ts";

const usage: Usage = {
	input: 100,
	output: 20,
	cacheRead: 60,
	cacheWrite: 10,
	totalTokens: 190,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
function message(counts: Usage = usage, model = "a"): AssistantMessage {
	return {
		role: "assistant",
		api: "openai-completions",
		provider: "test",
		model,
		content: [{ type: "text", text: "answer" }],
		usage: counts,
		stopReason: "stop",
		timestamp: Date.now(),
	};
}
test("durable usage counts billed compaction and retries, deduplicates replay and keeps input buckets disjoint", () => {
	const manager = SessionManager.inMemory();
	manager.appendCustomEntry(TURN_USAGE_ENTRY, "turn-a");
	manager.appendCustomEntry(TURN_USAGE_ENTRY, "turn-a");
	manager.appendMessage({ role: "user", content: "input", timestamp: Date.now() });
	const first = manager.appendMessage(message());
	manager.appendCustomEntry(STEP_TIMING_ENTRY, { llmMs: 1000, firstTokenMs: 500, decodeMs: 500, outputTokens: 20 });
	manager.appendMessage(message({ ...usage, input: 10, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 12 }));
	manager.appendCustomEntry(STEP_TIMING_ENTRY, { llmMs: 600, firstTokenMs: 500, decodeMs: 100, outputTokens: 2 });
	manager.appendMessage(message({ ...usage, input: -1 }));
	manager.appendCompaction("summary", first, 202, undefined, false, {
		...usage,
		input: 3,
		output: 2,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 5,
	});
	const entries = manager.getEntries();
	const result = deriveSessionUsage(
		[...entries, ...entries],
		manager.getBranch(),
		{ provider: "test", modelId: "a" },
		128000,
	);
	expect(result).toMatchObject({
		turns: 1,
		steps: 3,
		incomplete: true,
		tokens: { input: 113, output: 24, cacheRead: 60, cacheWrite: 10, totalTokens: 207 },
		decodeMs: 600,
		decodeTokens: 22,
		llmMs: 1600,
		contextTokensSource: "estimated",
	});
	expect(result.contextTokens).toBeGreaterThan(0);
});
test("changing back to an earlier model invalidates old context usage until that model replies again", () => {
	const manager = SessionManager.inMemory();
	manager.appendMessage(message());
	manager.appendModelChange("test", "b");
	manager.appendMessage(message(usage, "b"));
	manager.appendModelChange("test", "a");
	expect(
		deriveSessionUsage(manager.getEntries(), manager.getBranch(), { provider: "test", modelId: "a" }, 128000)
			.contextTokens,
	).toBeNull();
	manager.appendMessage(message());
	expect(
		deriveSessionUsage(manager.getEntries(), manager.getBranch(), { provider: "test", modelId: "a" }, 128000)
			.contextTokens,
	).toBe(190);
});

test("compaction immediately reports the retained context estimate without another model request", () => {
	const manager = SessionManager.inMemory();
	const first = manager.appendMessage({ role: "user", content: "待保留的项目目标", timestamp: Date.now() });
	manager.appendMessage(message({ ...usage, input: 10000, totalTokens: 10090 }));
	manager.appendCompaction("项目目标和下一步工作", first, 10090);
	const result = deriveSessionUsage(
		manager.getEntries(),
		manager.getBranch(),
		{ provider: "test", modelId: "a" },
		128000,
	);
	expect(result.contextTokens).toBeGreaterThan(0);
	expect(result.contextTokens).toBeLessThan(10090);
	expect(result.contextTokensSource).toBe("estimated");
	expect(result.tokens.totalTokens).toBe(10090);
	manager.appendMessage(message());
	expect(
		deriveSessionUsage(manager.getEntries(), manager.getBranch(), { provider: "test", modelId: "a" }, 128000),
	).toMatchObject({ contextTokens: 190, contextTokensSource: "reported" });
});
