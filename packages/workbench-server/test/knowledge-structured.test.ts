import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { DEFAULT_KNOWLEDGE_SETTINGS, splitDocument, validateKnowledgeSettings } from "../src/knowledge-chunker.ts";
import { type ParsedDocument, parseKnowledgeDocument } from "../src/knowledge-document-parser.ts";
import { assembleMarkdown, wordHtmlToMarkdown } from "../src/knowledge-markdown.ts";
import { renderKnowledgeContext, selectKnowledgeContext } from "../src/knowledge-retrieval.ts";
import { encodingTokenizer, loadKnowledgeTokenizer } from "../src/knowledge-tokenizer.ts";

const tokenizer = encodingTokenizer("cl100k_base");
function parsed(text: string): ParsedDocument {
	return {
		sections: [{ text }],
		diagnostics: [],
		...assembleMarkdown([{ text, source: { kind: "text", startLine: 1, endLine: text.split("\n").length } }]),
	};
}
const settings = { ...DEFAULT_KNOWLEDGE_SETTINGS, maxChunkTokens: 96, minChunkTokens: 40, overlapTokens: 0 };

test("preserves heading hierarchy, Chinese paragraphs, lists and source lines; only merges within a chapter", () => {
	const markdown =
		"# 项目\n\n## 索引\n\n第一段很短。\n\n第二段也很短。\n\n- 上传原件\n- 生成 Markdown\n\n## 检索\n\n使用 RRF 融合。";
	const chunks = splitDocument(parsed(markdown), tokenizer, settings);
	expect(chunks).toHaveLength(2);
	expect(chunks[0].headingPath).toEqual(["项目", "索引"]);
	expect(chunks[0].text).toContain("- 上传原件\n- 生成 Markdown");
	expect(chunks[0].text).not.toContain("RRF");
	expect(chunks[0].sources?.[0].startLine).toBe(5);
	expect(chunks[1].headingPath).toEqual(["项目", "检索"]);
});

test("splits Chinese and unbroken multilingual paragraphs without loss or surrogate damage and counts headings", () => {
	const text = "中文段落含版本 v2.1，不允许改变时间条件。".repeat(140) + "🧪数据😀".repeat(60);
	const chunks = splitDocument(parsed(`# 测试\n\n${text}`), tokenizer, settings);
	expect(chunks.length).toBeGreaterThan(5);
	expect(
		chunks.every((chunk) => tokenizer.count(chunk.text) <= 96 && chunk.tokenCount === tokenizer.count(chunk.text)),
	).toBe(true);
	expect(chunks.map((chunk) => chunk.text.replace(/^# 测试\n\n/u, "")).join("")).toBe(text);
	expect(chunks.some((chunk) => chunk.text.includes("�"))).toBe(false);
	expect(() => splitDocument(parsed(`# ${"超长标题".repeat(100)}\n\n正文`), tokenizer, settings)).toThrow("标题");
});

test("keeps table headers in every row split and code fences, indentation and function bodies", () => {
	const rows = Array.from({ length: 30 }, (_, i) => `| 项目 ${i} | 中文说明 ${i} |`).join("\n");
	const tables = splitDocument(parsed(`# 表格\n\n| 项目 | 说明 |\n| --- | --- |\n${rows}`), tokenizer, settings);
	expect(tables.length).toBeGreaterThan(1);
	for (const chunk of tables) {
		expect(chunk.text).toContain("| 项目 | 说明 |\n| --- | --- |");
		expect(tokenizer.count(chunk.text)).toBeLessThanOrEqual(96);
	}
	expect(tables.flatMap((chunk) => Array.from(chunk.text.matchAll(/\| 项目 \d+ \|/gu))).length).toBe(30);
	const longCell = "中文长单元格内容".repeat(100);
	const longTable = splitDocument(parsed(`| 键 | 内容 |\n| --- | --- |\n| id | ${longCell} |`), tokenizer, settings);
	expect(longTable.length).toBeGreaterThan(2);
	expect(
		longTable.every(
			(chunk) => tokenizer.count(chunk.text) <= 96 && chunk.text.startsWith("| 键 | 内容 |\n| --- | --- |"),
		),
	).toBe(true);
	expect(
		longTable
			.map((chunk) =>
				chunk.text
					.split("\n")
					.slice(2)
					.map((row) => row.split("|")[2]?.trim() ?? "")
					.join(""),
			)
			.join(""),
	).toBe(longCell);
	const code = Array.from({ length: 25 }, (_, i) => `function method${i}() {\n  return ${i};\n}\n`).join("\n");
	const codes = splitDocument(parsed(`# 代码\n\n\`\`\`ts\n${code}\`\`\``), tokenizer, settings);
	for (const chunk of codes) {
		expect(chunk.text).toMatch(/```ts\n/u);
		expect(chunk.text.endsWith("```")).toBe(true);
		expect(tokenizer.count(chunk.text)).toBeLessThanOrEqual(96);
	}
	for (const chunk of codes)
		expect([...chunk.text.matchAll(/function method\d+\(\) \{/gu)].length).toBe(
			[...chunk.text.matchAll(/\n\}/gu)].length,
		);
	expect(
		codes.map((chunk) => chunk.text.replace(/^# 代码\n\n```ts\n/u, "").replace(/\n```$/u, "")).join("\n"),
	).toContain("  return 24;");
});

test("uses an exact token boundary and charges citation and context wrappers to the final budget", () => {
	const text = "token ".repeat(87).trim();
	const tokens = tokenizer.count(`# title\n\n${text}`);
	expect(splitDocument(parsed(`# title\n\n${text}`), tokenizer, { ...settings, maxChunkTokens: tokens })).toHaveLength(
		1,
	);
	expect(
		splitDocument(parsed(`# title\n\n${text}`), tokenizer, { ...settings, maxChunkTokens: tokens - 1 }).length,
	).toBeGreaterThan(1);
	const hits = splitDocument(parsed(`# title\n\n${text}`), tokenizer, settings).map((chunk, index) => ({
		...chunk,
		id: `id-${index}`,
		path: "title.md",
		chunk: index,
		score: 1,
	}));
	const budget = tokenizer.count(renderKnowledgeContext([hits[0]]));
	const selected = selectKnowledgeContext(hits, tokenizer, budget, 20);
	expect(selected.contextTokens).toBe(tokenizer.count(selected.context));
	expect(selected.contextTokens).toBe(budget);
	expect(selected.context).toContain("title.md");
	expect(selectKnowledgeContext([hits[0]], tokenizer, budget - 1, 20).hits).toEqual([]);
	expect(validateKnowledgeSettings({ maxChunkTokens: 80, minChunkTokens: 79 }).maxChunkTokens).toBe(80);
	expect(() => validateKnowledgeSettings({ maxChunkTokens: 80, minChunkTokens: 90 })).toThrow();
});

test("converts semantic Word HTML and plaintext honestly, preserves originals, and fails unknown tokenizers", async () => {
	const sections = wordHtmlToMarkdown(
		"<h1>项目</h1><p>中文<strong>段落</strong></p><ul><li>第一项</li><li>第二项</li></ul><table><tr><th>名称</th><th>值</th></tr><tr><td>Token</td><td>96</td></tr></table>",
	);
	const word = assembleMarkdown(sections);
	expect(word.markdown).toContain("# 项目");
	expect(word.markdown).toContain("- 第一项\n- 第二项");
	expect(word.markdown).toContain("| 名称 | 值 |\n| --- | --- |\n| Token | 96 |");
	expect(word.sources[3]).toMatchObject({ kind: "docx", block: 4 });
	const root = await mkdtemp(join(tmpdir(), "workbench-md-"));
	try {
		const text = "原始段落。\r\n\r\n第二段。";
		const path = join(root, "original.txt");
		await writeFile(path, text);
		const value = await parseKnowledgeDocument(path, "original.txt");
		expect(value.markdown.startsWith("#")).toBe(false);
		expect(value.diagnostics.join("\n")).toContain("未推断");
		expect(await readFile(path, "utf8")).toBe(text);
		await expect(loadKnowledgeTokenizer({ model: "private-embedding" }, root)).rejects.toThrow("无法确认");
		await expect(
			loadKnowledgeTokenizer({ model: "private-embedding", tokenizerFile: "x", tokenizerModel: "wrong" }, root),
		).rejects.toThrow("匹配");
		await expect(
			loadKnowledgeTokenizer({ model: "private-embedding", tokenizer: "cl100k_base" }, root),
		).rejects.toThrow("匹配");
		expect((await loadKnowledgeTokenizer({ model: "text-embedding-3-small" }, root)).name).toBe("cl100k_base");
		await writeFile(
			join(root, "tokenizer.json"),
			JSON.stringify({
				model: {
					type: "WordPiece",
					unk_token: "[UNK]",
					vocab: { "[UNK]": 0, "[CLS]": 1, "[SEP]": 2, hello: 3, 中: 4, 文: 5 },
				},
				normalizer: { type: "BertNormalizer", clean_text: true, handle_chinese_chars: true, lowercase: false },
				pre_tokenizer: { type: "BertPreTokenizer" },
				post_processor: { type: "BertProcessing", cls: ["[CLS]", 1], sep: ["[SEP]", 2] },
				decoder: { type: "WordPiece", prefix: "##", cleanup: true },
				added_tokens: [
					{ id: 1, content: "[CLS]", special: true },
					{ id: 2, content: "[SEP]", special: true },
				],
			}),
		);
		await writeFile(
			join(root, "tokenizer_config.json"),
			JSON.stringify({
				tokenizer_class: "BertTokenizer",
				unk_token: "[UNK]",
				cls_token: "[CLS]",
				sep_token: "[SEP]",
			}),
		);
		const config = {
			model: "fixture-bert",
			tokenizerFile: "tokenizer.json",
			tokenizerConfigFile: "tokenizer_config.json",
			tokenizerModel: "fixture-bert",
		};
		const local = await loadKnowledgeTokenizer(config, root);
		expect(local.count("hello 中文")).toBe(5); // CLS + hello + 中 + 文 + SEP.
		await writeFile(
			join(root, "tokenizer_config.json"),
			JSON.stringify({ tokenizer_class: "BertTokenizer", do_lower_case: true }),
		);
		expect((await loadKnowledgeTokenizer(config, root)).fingerprint).not.toBe(local.fingerprint);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
