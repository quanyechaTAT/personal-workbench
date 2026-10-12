import { readFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { KnowledgePassage, KnowledgeSource } from "@earendil-works/workbench-core";
import { WorkbenchError } from "@earendil-works/workbench-core";
import mammoth from "mammoth";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import WordExtractor from "word-extractor";
import { fromBuffer, type ZipFile } from "yauzl";
import { assembleMarkdown, codeFence, type MarkdownSection, wordHtmlToMarkdown } from "./knowledge-markdown.ts";

export const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024;
export const TEXT_EXTENSIONS = new Set([
	".md",
	".markdown",
	".txt",
	".rst",
	".adoc",
	".ts",
	".tsx",
	".js",
	".jsx",
	".py",
	".go",
	".rs",
	".json",
	".yaml",
	".yml",
]);
const PDF_ROOT = dirname(fileURLToPath(import.meta.resolve("pdfjs-dist/package.json")));
export interface DocumentSection {
	text: string;
	page?: number;
}
export interface ParsedDocument {
	scanPages?: number[];
	sections: DocumentSection[];
	pageCount?: number;
	markdown: string;
	sources: KnowledgeSource[];
	diagnostics: string[];
}
export type DocumentPassage = KnowledgePassage;

export function documentMimeType(name: string): string {
	const extension = extname(name).toLowerCase();
	if (extension === ".pdf") return "application/pdf";
	if (extension === ".docx") return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
	if (extension === ".doc") return "application/msword";
	if ([".png", ".jpg", ".jpeg", ".bmp"].includes(extension))
		return extension === ".png" ? "image/png" : extension === ".bmp" ? "image/bmp" : "image/jpeg";
	if (extension === ".wav") return "audio/wav";
	if (extension === ".mp3") return "audio/mpeg";
	if (TEXT_EXTENSIONS.has(extension)) return "text/plain";
	throw new WorkbenchError("invalid_input", "请上传 PDF、Word、文本、PNG／JPG／BMP 图片或 WAV／MP3 音频");
}

async function validateWordArchive(buffer: Buffer): Promise<{ mergedCells: boolean; floating: boolean }> {
	const zip = await new Promise<ZipFile>((resolve, reject) =>
		fromBuffer(buffer, { lazyEntries: true, validateEntrySizes: true }, (error, value) =>
			error || !value ? reject(new WorkbenchError("invalid_input", "Word 文件不是有效的 DOCX")) : resolve(value),
		),
	);
	let total = 0;
	let entries = 0;
	let documentFound = false;
	const documentBytes: Buffer[] = [];
	try {
		for await (const entry of zip.eachEntry()) {
			if (++entries > 3000 || entry.isEncrypted() || entry.uncompressedSize > 32 * 1024 * 1024)
				throw new WorkbenchError("invalid_input", "Word 文件的解压大小或结构超过上限");
			if (entry.fileName === "word/document.xml") documentFound = true;
			const stream = await zip.openReadStreamPromise(entry);
			for await (const bytes of stream) {
				if (entry.fileName === "word/document.xml") documentBytes.push(Buffer.from(bytes));
				total += bytes.length;
				if (total > 64 * 1024 * 1024) {
					stream.destroy();
					throw new WorkbenchError("invalid_input", "Word 文件解压后超过 64 MiB");
				}
			}
		}
	} finally {
		zip.close();
	}
	if (!documentFound) throw new WorkbenchError("invalid_input", "DOCX 缺少 Word 正文");
	const xml = Buffer.concat(documentBytes).toString("utf8");
	return {
		mergedCells: /<(?:\w+:)?(?:gridSpan|vMerge)\b/u.test(xml),
		floating: /<(?:\w+:)?(?:anchor|textbox|txbxContent)\b/u.test(xml),
	};
}

export async function parseKnowledgeDocument(
	path: string,
	name: string,
	signal?: AbortSignal,
	allowScanned = false,
): Promise<ParsedDocument> {
	signal?.throwIfAborted();
	const bytes = await readFile(path);
	if (!bytes.length || bytes.length > MAX_DOCUMENT_BYTES)
		throw new WorkbenchError("invalid_input", "文档必须为非空文件，且不超过 20 MiB");
	const extension = extname(name).toLowerCase();
	let parsed: ParsedDocument;
	try {
		if (extension === ".pdf") {
			if (!bytes.subarray(0, 1024).includes(Buffer.from("%PDF-")))
				throw new WorkbenchError("invalid_input", "文件内容不是 PDF");
			const loading = getDocument({
				data: new Uint8Array(bytes),
				useWorkerFetch: false,
				disableFontFace: true,
				verbosity: 0,
				cMapUrl: `${join(PDF_ROOT, "cmaps")}/`,
				standardFontDataUrl: `${join(PDF_ROOT, "standard_fonts")}/`,
			});
			const cancel = () => {
				void loading.destroy();
			};
			signal?.addEventListener("abort", cancel, { once: true });
			try {
				const pdf = await loading.promise;
				if (pdf.numPages > 500) throw new WorkbenchError("invalid_input", "PDF 超过 500 页，请拆分后上传");
				const sections: DocumentSection[] = [];
				const scanPages: number[] = [];
				const markdownSections: MarkdownSection[] = [];
				const diagnostics = [
					"PDF 按文字位置和字号恢复段落及标题；复杂多栏、表格与代码结构可能不完整，请核对原件。未执行 OCR。",
				];
				let size = 0;
				for (let page = 1; page <= pdf.numPages; page++) {
					signal?.throwIfAborted();
					const contents = await (await pdf.getPage(page)).getTextContent();
					const text = contents.items
						.map((item) => ("str" in item ? item.str + (item.hasEOL ? "\n" : " ") : ""))
						.join("")
						.trim();
					size += text.length;
					if (size > 4_000_000) throw new WorkbenchError("invalid_input", "文档正文超过 400 万字符，请拆分后上传");
					if (text) sections.push({ text, page });
					else scanPages.push(page);
					const items = contents.items.flatMap((item, index) => ("str" in item ? [{ item, index }] : []));
					const heights = items
						.filter(({ item }) => item.str.trim())
						.map(({ item }) => item.height)
						.sort((a, b) => a - b);
					const normalHeight = heights[Math.floor(heights.length / 2)] ?? 12;
					let line = "";
					let start = 0;
					let heading = false;
					for (const { item, index } of items) {
						if (!line) {
							start = index;
							heading = item.height > normalHeight * 1.25;
						}
						line += item.str + (item.hasEOL ? "" : " ");
						if (item.hasEOL || index === items.at(-1)?.index) {
							if (line.trim())
								markdownSections.push({
									text: `${heading ? "## " : ""}${line.trim()}`,
									source: { kind: "pdf", page, textItemStart: start, textItemEnd: index + 1 },
								});
							line = "";
						}
					}
				}
				parsed = {
					sections,
					scanPages,
					pageCount: pdf.numPages,
					...assembleMarkdown(markdownSections),
					diagnostics,
				};
			} finally {
				signal?.removeEventListener("abort", cancel);
				await loading.destroy();
			}
		} else if (extension === ".docx") {
			const features = await validateWordArchive(bytes);
			let imageCount = 0;
			const result = await mammoth.convertToHtml(
				{ buffer: bytes },
				{
					externalFileAccess: false,
					includeEmbeddedStyleMap: false,
					styleMap: [
						"p[style-name='Body Text'] => p:fresh",
						"p[style-name='BodyText'] => p:fresh",
						"p[style-name='正文'] => p:fresh",
						"p[style-name='Body Text 2'] => p:fresh",
						"p[style-name='Body Text 3'] => p:fresh",
					],
					convertImage: mammoth.images.imgElement(async () => ({
						src: "",
						alt: `DOCX 内嵌图片 ${++imageCount}（图像保留于原件，请下载核对）`,
					})),
				},
			);
			const converted = wordHtmlToMarkdown(result.value);
			parsed = {
				sections: converted.map(({ text }) => ({ text })),
				...assembleMarkdown(converted),
				diagnostics: [
					"DOCX 已按标题、段落、列表和表格转换；来源定位到正文语义块。Word 页码依赖排版引擎，当前未生成分页，可下载原件核对。",
					...(features.mergedCells
						? ["DOCX 含合并单元格：Markdown 展开可恢复的横向列并保留文字；纵向合并／复杂嵌套需核对原始表格。"]
						: []),
					...(imageCount
						? [
								`DOCX 含 ${imageCount} 张内嵌图片，Markdown 保留出现位置；未对图片执行识别，图像完整保留在 Word 原件。`,
							]
						: []),
					...(features.floating
						? ["DOCX 含浮动对象或文本框；语义阅读顺序与原始排版可能不同，请下载原件核对。"]
						: []),
					...result.messages.map((message) => `DOCX 转换诊断：${message.message}`),
				],
			};
		} else if (extension === ".doc") {
			if (bytes.subarray(0, 8).toString("hex") !== "d0cf11e0a1b11ae1")
				throw new WorkbenchError("invalid_input", "文件内容不是旧版 Word 文档");
			const value = await new WordExtractor().extract(bytes);
			const text = [value.getBody(), value.getFootnotes(), value.getEndnotes()].filter(Boolean).join("\n\n");
			parsed = {
				sections: [{ text }],
				...assembleMarkdown([{ text, source: { kind: "doc", originalStart: 0, originalEnd: text.length } }]),
				diagnostics: [
					"旧版 DOC 仅恢复正文和段落，无法可靠恢复标题、表格或排版页码；建议另存为 DOCX 后上传。原文位置为提取正文的字符偏移。",
				],
			};
		} else {
			documentMimeType(name);
			const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
			if (text.includes("\0")) throw new WorkbenchError("invalid_input", "该文件是二进制内容，无法作为文本索引");
			const markdown = text.replace(/\r\n?/gu, "\n");
			const code = ![".md", ".markdown", ".txt", ".rst", ".adoc"].includes(extension);
			const converted = code ? codeFence(markdown, extension.slice(1)) : markdown;
			const sources: KnowledgeSource[] = [];
			let markdownOffset = code ? converted.indexOf("\n") + 1 : 0;
			let line = 1;
			for (const match of text.matchAll(/[^\r\n]*(?:\r\n?|\n|$)/gu)) {
				if (!match[0]) continue;
				const width = match[0].replace(/\r\n?/gu, "\n").length;
				sources.push({
					kind: "text",
					markdownStart: markdownOffset,
					markdownEnd: markdownOffset + width,
					startLine: line,
					endLine: line,
					originalStart: match.index,
					originalEnd: match.index + match[0].length,
				});
				markdownOffset += width;
				line++;
			}
			parsed = {
				sections: [{ text }],
				markdown: converted,
				sources,
				diagnostics:
					[".md", ".markdown"].includes(extension) || code
						? []
						: [
								"文本仅保留已有段落、列表和可识别的 Markdown 边界；未推断或添加章节标题。RST／AsciiDoc 专用语法未完整转换。",
							],
			};
		}
	} catch (error) {
		signal?.throwIfAborted();
		if (error instanceof WorkbenchError) throw error;
		throw new WorkbenchError("invalid_input", "无法解析文档，请检查文件是否损坏、加密或格式不匹配");
	}
	signal?.throwIfAborted();
	const length = parsed.sections.reduce((sum, section) => sum + section.text.length, 0);
	if (!length && !(allowScanned && extension === ".pdf" && parsed.scanPages?.length))
		throw new WorkbenchError(
			"invalid_input",
			extension === ".pdf" ? "PDF 未发现可提取文字；扫描件需要先完成 OCR 再上传" : "文档中没有可提取的正文",
		);
	if (length > 4_000_000) throw new WorkbenchError("invalid_input", "文档正文超过 400 万字符，请拆分后上传");
	return parsed;
}
