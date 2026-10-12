import { expect, test } from "vitest";
import { DEFAULT_KNOWLEDGE_SETTINGS } from "../src/knowledge-chunker.ts";
import { expandQueries, expansionPolicy, necessaryQueryContext, validExpansion } from "../src/knowledge-mqe.ts";
import { fuseKnowledge } from "../src/knowledge-retrieval.ts";

test("keeps the exact original query and at most two distinct valid rewrites", async () => {
	const query = "检索 Qwen3 v2.1 的 2025 数据，不使用新版";
	const result = await expandQueries(query, { ...DEFAULT_KNOWLEDGE_SETTINGS, mqe: "always" }, [], async () =>
		JSON.stringify({ queries: [query, "查找 Qwen3 v2.1 在 2025 的数据，不使用新版"] }),
	);
	expect(result.queries).toEqual([query, "查找 Qwen3 v2.1 在 2025 的数据，不使用新版"]);
	expect(result.mqe.applied).toBe(true);
	for (const invalid of [
		"Qwen4 v2.1 的 2025 数据，不使用新版",
		"Qwen3 v3.0 的 2025 数据，不使用新版",
		"Qwen3 v2.1 的 2026 数据，不使用新版",
		"Qwen3 v2.1 的 2025 数据，使用新版",
		"Qwen3 v2.1 的 2025 数据，因为模型升级不使用新版",
	])
		expect(validExpansion(query, invalid, [])).toBe(false);
	const duplicates = await expandQueries(
		"检索数据",
		{ ...DEFAULT_KNOWLEDGE_SETTINGS, mqe: "always" },
		[],
		async () => '{"queries":["检索 数据。","检索数据！"]}',
	);
	expect(duplicates.queries).toEqual(["检索数据"]);
});

test("falls back on failure, timeout, oversized output, invalid constraints and tool-free generation refusal", async () => {
	for (const generate of [
		async () => {
			throw new Error("provider-secret");
		},
		async () => "invalid JSON",
		async () => '{"queries":["a","b","c"]}',
		async () => undefined,
	]) {
		const result = await expandQueries("查找数据", { ...DEFAULT_KNOWLEDGE_SETTINGS, mqe: "always" }, [], generate);
		expect(result.queries).toEqual(["查找数据"]);
		expect(result.diagnostics.join()).not.toContain("provider-secret");
	}
	const result = await expandQueries(
		"查找数据",
		{ ...DEFAULT_KNOWLEDGE_SETTINGS, mqe: "always", mqeTimeoutMs: 10 },
		[],
		async () => new Promise(() => {}),
	);
	expect(result.queries).toEqual(["查找数据"]);
	expect(result.diagnostics.join()).toContain("超时");
});

test("auto policy is explainable; only reference resolution gets bounded current-session text", () => {
	expect(expansionPolicy("off", "如何检索", []).enabled).toBe(false);
	expect(expansionPolicy("auto", "Qwen3 v2.1", []).enabled).toBe(false);
	expect(expansionPolicy("auto", "如何比较版本", []).enabled).toBe(true);
	expect(expansionPolicy("auto", "它支持什么", []).enabled).toBe(false);
	const history = [
		{
			id: "u",
			role: "user" as const,
			content: [{ type: "text" as const, text: "正在研究 Qwen3" }],
			timestamp: "now",
		},
		{ id: "t", role: "tool" as const, content: [{ type: "text" as const, text: "tool-secret" }], timestamp: "now" },
	];
	expect(necessaryQueryContext("它支持什么", history)).toEqual([{ role: "user", text: "正在研究 Qwen3" }]);
	expect(necessaryQueryContext("Qwen3 参数", history)).toEqual([]);
	expect(expansionPolicy("auto", "它支持什么", necessaryQueryContext("它支持什么", history)).reason).toContain(
		"本会话",
	);
});

test("cancels an in-flight MQE request without reporting fallback success", async () => {
	const controller = new AbortController();
	let generatorSignal: AbortSignal | undefined;
	const pending = expandQueries(
		"如何检索",
		DEFAULT_KNOWLEDGE_SETTINGS,
		[],
		async (_prompt, signal) => {
			generatorSignal = signal;
			return new Promise(() => {});
		},
		controller.signal,
	);
	controller.abort();
	await expect(pending).rejects.toMatchObject({ name: "AbortError" });
	expect(generatorSignal?.aborted).toBe(true);
});

test("RRF deduplicates stable ids within and across lists and retains every query/source match", () => {
	const first = { id: "stable", path: "a.md", chunk: 0, text: "first", score: 1 };
	const second = { id: "other", path: "b.md", chunk: 0, text: "second", score: 1 };
	const fused = fuseKnowledge([
		{ query: "原始", method: "vector", hits: [first, first, second] },
		{ query: "扩展", method: "keyword", hits: [first] },
	]);
	expect(fused).toHaveLength(2);
	expect(fused[0].id).toBe("stable");
	expect(fused[0].score).toBeCloseTo(2 / 61);
	expect(fused[0].matches).toHaveLength(2);
});
