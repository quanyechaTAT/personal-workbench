import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import JSZip from "jszip";
import { expect, test } from "vitest";
import { DEFAULT_KNOWLEDGE_SETTINGS, splitDocument, validateKnowledgeSettings } from "../src/knowledge-chunker.ts";
import { parseKnowledgeDocument } from "../src/knowledge-document-parser.ts";
import { assembleMarkdown, wordHtmlToMarkdown } from "../src/knowledge-markdown.ts";
import { encodingTokenizer } from "../src/knowledge-tokenizer.ts";
import { BailianPerceptionAdapter } from "../src/perception-adapter.ts";
import { docxDocument } from "./fixtures/knowledge-documents.ts";

test("Body Text with numeric Word style ID converts as paragraphs without unknown-style noise", async () => {
	const root = await mkdtemp(join(tmpdir(), "workbench-word-style-"));
	try {
		const zip = await JSZip.loadAsync(await docxDocument(""));
		zip.file(
			"word/styles.xml",
			'<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:styleId="3"><w:name w:val="Body Text"/></w:style></w:styles>',
		);
		zip.file(
			"word/_rels/document.xml.rels",
			'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="styles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>',
		);
		zip.file(
			"word/document.xml",
			'<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:pPr><w:pStyle w:val="3"/></w:pPr><w:r><w:t>第一段中文正文。</w:t></w:r></w:p><w:p><w:pPr><w:pStyle w:val="3"/></w:pPr><w:r><w:t>第二段保留语义边界。</w:t></w:r></w:p></w:body></w:document>',
		);
		const original = await zip.generateAsync({ type: "nodebuffer" });
		const path = join(root, "正文.docx");
		await writeFile(path, original);
		const value = await parseKnowledgeDocument(path, "正文.docx");
		expect(value.markdown).toBe("第一段中文正文。\n\n第二段保留语义边界。");
		expect(value.diagnostics.join("\n")).not.toContain("Unrecognised paragraph style");
		expect(value.sources).toHaveLength(2);
		expect(await readFile(path)).toEqual(original);
	} finally {
		expect(dirname(root)).toBe(tmpdir());
		await rm(root, { recursive: true, force: true });
	}
});

test("configurable overlap preserves Chinese boundary context and remains in the full Token cap", () => {
	const text = Array.from({ length: 35 }, (_, i) => `中文第${i}句包含实体星辰和版本v2.1，不改变否定条件。`).join("");
	const tokenizer = encodingTokenizer("cl100k_base");
	const settings = validateKnowledgeSettings({
		...DEFAULT_KNOWLEDGE_SETTINGS,
		maxChunkTokens: 96,
		minChunkTokens: 0,
		overlapTokens: 20,
	});
	expect(settings).toHaveProperty("overlapTokens", 20);
	const parsed = {
		sections: [{ text }],
		diagnostics: [],
		...assembleMarkdown([
			{ text: `# 项目\n\n${text}`, source: { kind: "text", originalStart: 0, originalEnd: text.length + 6 } },
		]),
	};
	const chunks = splitDocument(parsed, tokenizer, settings);
	expect(chunks.length).toBeGreaterThan(2);
	for (let i = 1; i < chunks.length; i++) {
		const before = chunks[i - 1].text.replace(/^# 项目\n\n/u, "");
		const current = chunks[i].text.replace(/^# 项目\n\n/u, "");
		const shared = Array.from({ length: before.length }, (_, n) => before.slice(n))
			.filter((suffix) => current.startsWith(suffix))
			.sort((a, b) => b.length - a.length)[0];
		expect(shared?.length ?? 0).toBeGreaterThan(0);
		expect(tokenizer.count(chunks[i].text)).toBeLessThanOrEqual(96);
		expect(chunks[i].markdownStart).toBeLessThan(chunks[i - 1].markdownEnd ?? 0);
	}
	expect(() => validateKnowledgeSettings({ maxChunkTokens: 64, minChunkTokens: 0, overlapTokens: 64 })).toThrow(
		"重叠",
	);
});

test.each(["AccessDenied.Unpurchased", "AllocationQuota.FreeTierOnly", "InvalidApiKey", "ModelNotFound"])(
	"perception diagnostics retain safe provider code %s without credential or upstream message",
	async (code) => {
		const root = await mkdtemp(join(tmpdir(), "workbench-403-"));
		try {
			const envFile = join(root, ".env");
			await writeFile(
				envFile,
				"EMBED_API_KEY=fixture-private-key\nEMBED_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1\n",
			);
			let calls = 0;
			const adapter = new BailianPerceptionAdapter(envFile, async () => {
				calls++;
				return new Response(JSON.stringify({ error: { code, message: "fixture-private-key secret payload" } }), {
					status: 403,
				});
			});
			const endpoint = await adapter.configuration.endpoint("vision");
			const image = {
				dataUrl: "data:image/png;base64,fixture",
				width: 10,
				height: 10,
				originalWidth: 10,
				originalHeight: 10,
			};
			const error = await adapter
				.describe(image, endpoint, new AbortController().signal)
				.catch((value: unknown) => value);
			expect(error).toBeInstanceOf(Error);
			if (!(error instanceof Error)) throw new Error("Expected perception failure");
			expect(error.message).toContain(code);
			expect(error.message).not.toContain("fixture-private-key");
			expect(error.message).not.toContain("secret payload");
			expect(calls).toBe(1);
		} finally {
			expect(dirname(root)).toBe(tmpdir());
			await rm(root, { recursive: true, force: true });
		}
	},
);

test("overlap keeps table rows, repeated headers, code fences and section isolation without dropping content", () => {
	const tokenizer = encodingTokenizer("cl100k_base");
	const settings = validateKnowledgeSettings({ maxChunkTokens: 96, minChunkTokens: 0, overlapTokens: 24 });
	const rows = Array.from({ length: 40 }, (_, i) => `| item${i} | data${i} |`).join("\n");
	const code = Array.from({ length: 40 }, (_, i) => `  const value${i} = ${i};`).join("\n");
	const markdown = `# 文档\n\n## 表格\n\n| 项目 | 说明 |\n| --- | --- |\n${rows}\n\n## 代码\n\n\`\`\`ts\n${code}\n\`\`\``;
	const parsed = {
		sections: [{ text: markdown }],
		diagnostics: [],
		...assembleMarkdown([{ text: markdown, source: { kind: "text" } }]),
	};
	const chunks = splitDocument(parsed, tokenizer, settings);
	expect(chunks.some((chunk) => chunk.overlap)).toBe(true);
	for (const chunk of chunks) {
		expect(tokenizer.count(chunk.text)).toBeLessThanOrEqual(96);
		if (chunk.headingPath?.at(-1) === "表格") {
			expect(chunk.text).toContain("| 项目 | 说明 |\n| --- | --- |");
			expect(chunk.text).not.toContain("const value");
		} else {
			expect(chunk.text).toContain("```ts\n");
			expect(chunk.text.endsWith("```")).toBe(true);
		}
	}
	for (let i = 0; i < 40; i++) {
		expect(chunks.some((chunk) => chunk.text.includes(`| item${i} | data${i} |`))).toBe(true);
		expect(chunks.some((chunk) => chunk.text.includes(`const value${i} = ${i};`))).toBe(true);
	}
});

test("Word images retain their occurrence and merged cells do not shift columns", () => {
	const value = assembleMarkdown(
		wordHtmlToMarkdown(
			'<p>正文<img src="" alt="DOCX 内嵌图片 1（保留于原件）"></p><table><tr><td colspan="2">合并标题</td><td>第三列</td></tr><tr><td>A</td><td>B</td><td>C</td></tr></table>',
		),
	);
	expect(value.markdown).toContain("【DOCX 内嵌图片 1（保留于原件）】");
	expect(value.markdown).toContain("| 合并标题 | （同左合并单元格） | 第三列 |");
	expect(value.markdown).toContain("| A | B | C |");
});

test("real DOCX retains embedded image positions and diagnoses only present layout features", async () => {
	const root = await mkdtemp(join(tmpdir(), "workbench-word-layout-"));
	try {
		const zip = await JSZip.loadAsync(await docxDocument(""));
		zip.file(
			"word/_rels/document.xml.rels",
			'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="picture" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/></Relationships>',
		);
		zip.file(
			"word/media/image1.png",
			Buffer.from(
				"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQ0AAAAASUVORK5CYII=",
				"base64",
			),
		);
		zip.file(
			"word/document.xml",
			'<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body><w:p><w:r><w:t>正文图像位置</w:t></w:r><w:r><w:drawing><wp:inline><wp:docPr id="1" name="Picture"/><a:graphic><a:graphicData><pic:pic><pic:blipFill><a:blip r:embed="picture"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p><w:tbl><w:tblGrid><w:gridCol/><w:gridCol/><w:gridCol/></w:tblGrid><w:tr><w:tc><w:tcPr><w:gridSpan w:val="2"/></w:tcPr><w:p><w:r><w:t>合并标题</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>第三列</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>',
		);
		const path = join(root, "图像表格.docx");
		const bytes = await zip.generateAsync({ type: "nodebuffer" });
		await writeFile(path, bytes);
		const value = await parseKnowledgeDocument(path, "图像表格.docx");
		expect(value.markdown).toContain("DOCX 内嵌图片 1");
		expect(value.markdown).toContain("| 合并标题 | （同左合并单元格） | 第三列 |");
		expect(value.diagnostics.join("\n")).toContain("含 1 张内嵌图片");
		expect(value.diagnostics.join("\n")).toContain("含合并单元格");
		expect(value.diagnostics.join("\n")).not.toContain("含浮动对象");
		expect(await readFile(path)).toEqual(bytes);
	} finally {
		expect(dirname(root)).toBe(tmpdir());
		await rm(root, { recursive: true, force: true });
	}
});

test("overlap never crosses repeated heading occurrences or PDF page boundaries", () => {
	const tokenizer = encodingTokenizer("cl100k_base");
	const settings = validateKnowledgeSettings({ maxChunkTokens: 96, minChunkTokens: 0, overlapTokens: 20 });
	const markdown = "# 重复标题\n\n第一章独有文字。\n\n# 重复标题\n\n第二章独有文字。";
	const parsed = {
		sections: [{ text: markdown }],
		diagnostics: [],
		...assembleMarkdown([{ text: markdown, source: { kind: "text" } }]),
	};
	const chunks = splitDocument(parsed, tokenizer, settings);
	expect(chunks).toHaveLength(2);
	expect(chunks[1].overlap).toBeUndefined();
	expect(chunks[1].text).not.toContain("第一章");
	const pages = assembleMarkdown([
		{ text: "第一页边界信息。", source: { kind: "pdf", page: 1 } },
		{ text: "第二页不同来源。", source: { kind: "pdf", page: 2 } },
	]);
	const pageChunks = splitDocument({ ...pages, diagnostics: [], sections: [] }, tokenizer, settings);
	expect(pageChunks).toHaveLength(2);
	expect(pageChunks[1].overlap).toBeUndefined();
});
