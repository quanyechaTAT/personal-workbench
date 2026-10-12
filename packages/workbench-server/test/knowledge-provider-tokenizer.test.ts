import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { DEFAULT_KNOWLEDGE_SETTINGS, splitDocument } from "../src/knowledge-chunker.ts";
import { type EmbeddingConfig, KnowledgeEmbeddingClient } from "../src/knowledge-embedding.ts";
import { assembleMarkdown } from "../src/knowledge-markdown.ts";
import { renderKnowledgeContext } from "../src/knowledge-retrieval.ts";
import { encodingTokenizer, loadKnowledgeTokenizer, withKnowledgeTokenizer } from "../src/knowledge-tokenizer.ts";
import { createKnowledgeFixture } from "./knowledge-rag-fixture.ts";

const config: EmbeddingConfig = {
	model: "qwen3.7-text-embedding",
	url: new URL("https://dashscope.aliyuncs.com/compatible-mode/v1/embeddings"),
	apiKey: "test-only",
	fingerprint: "test-space",
	tokenizer: "provider-usage",
	tokenizerModel: "qwen3.7-text-embedding",
};

test("counts the selected embedding model's single-input usage, reuses vectors, and rejects missing or invalid usage", async () => {
	let requests = 0;
	const client = new KnowledgeEmbeddingClient("unused", async (_url, init) => {
		requests++;
		const { input, model } = JSON.parse(String(init?.body)) as { input: string[]; model: string };
		expect(model).toBe(config.model);
		expect(input).toHaveLength(1);
		return Response.json({ data: [{ index: 0, embedding: [1, 0] }], usage: { total_tokens: 17 } });
	});
	const tokenizer = await loadKnowledgeTokenizer(config, ".", (text, signal) => client.measure(config, text, signal));
	expect(await withKnowledgeTokenizer(tokenizer, () => tokenizer.count("中文标题和正文"))).toBe(17);
	expect(await client.embed(config, ["中文标题和正文"])).toEqual([[1, 0]]);
	expect(requests).toBe(1);
	for (const usage of [
		undefined,
		{ total_tokens: -1 },
		{ total_tokens: 0 },
		{ total_tokens: 1.5 },
		{ total_tokens: "17" },
	]) {
		const invalid = new KnowledgeEmbeddingClient("unused", async () =>
			Response.json({ data: [{ index: 0, embedding: [1, 0] }], usage }),
		);
		await expect(invalid.measure(config, "正文")).rejects.toThrow("usage.total_tokens");
	}
	await expect(client.embed(config, Array<string>(21).fill("text"))).rejects.toThrow("最多 20");
	await expect(loadKnowledgeTokenizer({ ...config, tokenizerModel: "wrong" }, ".", async () => 1)).rejects.toThrow(
		"匹配",
	);
	const cancelled = new AbortController();
	cancelled.abort();
	await expect(
		withKnowledgeTokenizer(tokenizer, () => tokenizer.count("未计量"), cancelled.signal),
	).rejects.toMatchObject({ name: "AbortError" });
});

test("uses actual provider counts for Chinese headings, tables, code and the exact final context budget through real SQLite/Gateway", async () => {
	const reference = encodingTokenizer("cl100k_base");
	// Deliberately differs from the local encoding, proving it cannot silently supply the reported count.
	const actual = (text: string) => reference.count(text) + 7;
	const rig = await createKnowledgeFixture(() => [1, 0], { model: config.model, tokenUsage: actual });
	try {
		const project = await rig.project("百炼计量回归");
		const text = `# 中文规范\n\n## 表格\n\n| 列名 | 描述 |\n| --- | --- |\n${"| 标识 | 中文内容必须保留来源 |\n".repeat(10)}\n\n## 代码\n\n\`\`\`ts\n${"function sample() {\n  return 1;\n}\n".repeat(12)}\`\`\``;
		await writeFile(join(project.sourcePath ?? "", "rules.md"), text);
		await rig.fixture.application.services.knowledge.configure(project, {
			maxChunkTokens: 96,
			minChunkTokens: 24,
			contextTokens: 550,
			mqe: "off",
		});
		await rig.fixture.application.services.knowledge.index(project);
		const chunks = await rig.fixture.application.repositories.knowledge.listChunks(project.id);
		expect(chunks.length).toBeGreaterThan(2);
		expect(chunks.every((chunk) => chunk.tokenCount === actual(chunk.text) && chunk.tokenCount <= 96)).toBe(true);
		const before = rig.requests.length;
		const result = await rig.fixture.application.services.knowledge.retrieve(project, "中文规范", 5);
		expect(result.hits.length).toBeGreaterThan(0);
		expect(result.contextTokens).toBe(actual(renderKnowledgeContext(result.hits)));
		expect(result.contextTokens).toBeLessThanOrEqual(550);
		expect(result.tokenizer).toContain("供应商实际");
		expect(rig.requests.slice(before)).toContainEqual(["中文规范"]);
		await rig.fixture.application.services.knowledge.configure(project, {
			maxChunkTokens: 96,
			minChunkTokens: 24,
			contextTokens: 550,
			mqe: "always",
		});
		const batchStart = rig.requests.length;
		const expanded = await rig.fixture.application.services.knowledge.retrieve(project, "中文规范", 5, undefined, {
			generate: async () => '{"queries":["规范中的中文条款","中文规范的资料"]}',
		});
		expect(expanded.queries).toHaveLength(3);
		expect(rig.requests.slice(batchStart)).toContainEqual(expanded.queries);
		await rig.fixture.application.services.knowledge.configure(project, {
			maxChunkTokens: 96,
			minChunkTokens: 24,
			contextTokens: 550,
			mqe: "off",
			hyde: "always",
		});
		const hypothetical = "中文规范检索可能涉及表格、代码与来源说明。假设计量标记仅用于向量召回，不作为证据。";
		const hyde = await rig.fixture.application.services.knowledge.retrieve(project, "中文规范检索", 5, undefined, {
			generateHypothesis: async () => JSON.stringify({ document: hypothetical }),
		});
		expect(hyde.hyde?.applied).toBe(true);
		expect(hyde.hyde?.tokenCount).toBe(actual(hypothetical));
		expect(hyde.contextTokens).toBe(actual(renderKnowledgeContext(hyde.hits)));
		expect(hyde.context).not.toContain("假设计量标记");
		await rig.fixture.restart();
		expect((await rig.fixture.application.services.knowledge.status(project)).staleFileCount).toBe(0);
		const controller = new AbortController();
		rig.setMode("hold");
		const pending = rig.fixture.application.services.knowledge.retrieve(
			project,
			"需要取消的计量请求",
			5,
			controller.signal,
		);
		await expect.poll(() => rig.requests.some((input) => input.includes("需要取消的计量请求"))).toBe(true);
		controller.abort();
		await expect(pending).rejects.toMatchObject({ name: "AbortError" });
	} finally {
		await rig.close();
	}
}, 45000);

test("structurally splits oversized inputs before submission and measures every emitted passage", async () => {
	const tokenizer = await loadKnowledgeTokenizer(config, ".", async (text) => {
		expect(Buffer.byteLength(text)).toBeLessThanOrEqual(120000);
		return Math.ceil(text.length / 2000) + 1;
	});
	const text = "中文长文".repeat(15000);
	const parsed = {
		sections: [{ text }],
		diagnostics: [],
		...assembleMarkdown([{ text, source: { kind: "text" as const } }]),
	};
	const chunks = await withKnowledgeTokenizer(tokenizer, () =>
		splitDocument(parsed, tokenizer, { ...DEFAULT_KNOWLEDGE_SETTINGS, maxChunkTokens: 64, overlapTokens: 0 }),
	);
	expect(chunks.length).toBeGreaterThan(1);
	expect(chunks.every((chunk) => Number.isFinite(chunk.tokenCount) && (chunk.tokenCount ?? Infinity) <= 64)).toBe(
		true,
	);
	expect(chunks.map((chunk) => chunk.text).join("")).toBe(text);
});
