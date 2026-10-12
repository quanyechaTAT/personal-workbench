import { expect, test } from "vitest";
import { DEFAULT_KNOWLEDGE_SETTINGS, validateKnowledgeSettings } from "../src/knowledge-chunker.ts";
import { generateHyde, hydePolicy, validHypothesis } from "../src/knowledge-hyde.ts";

const enabled = { ...DEFAULT_KNOWLEDGE_SETTINGS, hyde: "always" as const };
const query = "Qwen3 v2.1 的 2025 数据，不使用新版";
const document = "Qwen3 v2.1 的资料讨论 2025 数据，不使用新版。相关文档可能说明数据筛选、检索匹配和来源保留的方法。";

test("generates one hypothetical document while preserving entities, versions, time and negation", async () => {
	const result = await generateHyde(query, enabled, [], async () => JSON.stringify({ document }));
	expect(result.hyde.document).toBe(document);
	expect(result.hyde.applied).toBe(false); // Only a successful vector recall can mark it applied.
	for (const invalid of [
		document.replace("v2.1", "v3.0"),
		document.replace("2025", "2026"),
		document.replace("不使用新版", "使用新版"),
		`${document} 新版本为 v3.0。`,
		`${document} https://fabricated.example/paper`,
	])
		expect(validHypothesis(query, invalid, [])).toBe(false);
});

test("off and automatic modes are explainable and old settings remain off without reindexing", async () => {
	let calls = 0;
	const result = await generateHyde("如何寻找文档", DEFAULT_KNOWLEDGE_SETTINGS, [], async () => {
		calls++;
		return "";
	});
	expect(result.hyde.mode).toBe("off");
	expect(calls).toBe(0);
	expect(hydePolicy("auto", "如何融合检索", []).enabled).toBe(true);
	expect(hydePolicy("auto", query, []).enabled).toBe(false);
	expect(hydePolicy("auto", "它如何检索", []).enabled).toBe(false);
	expect(hydePolicy("auto", "它如何检索", [{ role: "user", text: "星辰项目" }]).enabled).toBe(true);
	expect(hydePolicy("auto", "它的 2025 数据如何检索", [{ role: "user", text: "星辰项目" }]).enabled).toBe(false);
	expect(validateKnowledgeSettings({ mqe: "auto" }).hyde).toBe("off");
	expect(() => validateKnowledgeSettings({ hyde: "invalid" })).toThrow("HyDE");
});

test("fails safely on unavailable models, malformed output, invalid constraints, refusal and timeout", async () => {
	for (const generate of [
		undefined,
		async () => undefined,
		async () => "not JSON",
		async () => '{"document":[]}',
		async () => JSON.stringify({ document: document.replace("Qwen3", "Qwen4") }),
		async () => {
			throw new Error("credential-secret");
		},
	]) {
		const result = await generateHyde(query, enabled, [], generate);
		expect(result.hyde.document).toBeUndefined();
		expect(result.diagnostics.length).toBeGreaterThan(0);
		expect(result.diagnostics.join()).not.toContain("credential-secret");
	}
	const result = await generateHyde(query, { ...enabled, hydeTimeoutMs: 10 }, [], async () => new Promise(() => {}));
	expect(result.diagnostics.join()).toContain("超时");
});

test("uses context only for pronouns and propagates cancellation to the isolated generation", async () => {
	const history = [{ role: "user" as const, text: "Qwen3 使用 2025 数据。" }];
	await generateHyde(query, enabled, history, async (prompt) => {
		expect(JSON.parse(prompt).context).toEqual([]);
		return JSON.stringify({ document });
	});
	const controller = new AbortController();
	let generationSignal: AbortSignal | undefined;
	const pending = generateHyde(
		"它如何检索",
		enabled,
		history,
		async (prompt, signal) => {
			expect(JSON.parse(prompt).context).toEqual(history);
			generationSignal = signal;
			return new Promise(() => {});
		},
		controller.signal,
	);
	controller.abort();
	await expect(pending).rejects.toMatchObject({ name: "AbortError" });
	expect(generationSignal?.aborted).toBe(true);
});
