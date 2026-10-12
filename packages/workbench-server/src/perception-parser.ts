import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type {
	KnowledgeDocument,
	KnowledgeRepository,
	KnowledgeSource,
	PerceptualRepresentation,
} from "@earendil-works/workbench-core";
import { WorkbenchError } from "@earendil-works/workbench-core";
import type { ParsedDocument } from "./knowledge-document-parser.ts";
import { parseDocumentInWorker } from "./knowledge-parser.ts";
import type { PerceptionAdapter, PerceptionImage, PerceptionOutput } from "./perception-adapter.ts";
import { validateAudio } from "./perception-adapter.ts";
import type { PerceptionCapability, PerceptionEndpoint } from "./perception-config.ts";
import { prepareImage, renderScannedPages } from "./perception-images.ts";

export interface PerceptionParserOptions {
	repository: KnowledgeRepository;
	adapter: PerceptionAdapter;
	onProgress: (stage: KnowledgeDocument["processingStage"], completed: number, total: number) => Promise<void>;
	retain: (value: PerceptualRepresentation) => Promise<void>;
	retainPage: (page: number, bytes: Buffer) => Promise<void>;
	onImage: (image: PerceptionImage, text: string, sources: KnowledgeSource[]) => Promise<void>;
}

export async function parsePerceptualDocument(
	path: string,
	document: KnowledgeDocument,
	signal: AbortSignal,
	options: PerceptionParserOptions,
): Promise<ParsedDocument> {
	const bytes = await readFile(path);
	const image = document.mimeType.startsWith("image/");
	const audio = document.mimeType.startsWith("audio/");
	const parsed: ParsedDocument =
		image || audio
			? { sections: [], markdown: "", sources: [], diagnostics: [] }
			: await parseDocumentInWorker(path, document.name, signal, true);
	parsed.sources = parsed.sources.map((source) => ({
		...source,
		representation: "original_text",
		origin: "original",
	}));
	const previous = await options.repository.listRepresentations(document.projectId, document.id);
	const endpoints = new Map<PerceptionCapability, PerceptionEndpoint>();
	const capability = async (name: PerceptionCapability): Promise<PerceptionEndpoint | undefined> => {
		if (endpoints.has(name)) return endpoints.get(name);
		try {
			const result = await options.adapter.configuration.endpoint(name);
			endpoints.set(name, result);
			return result;
		} catch (error) {
			parsed.diagnostics.push(error instanceof WorkbenchError ? error.message : `${name.toUpperCase()} 配置不可用`);
			return undefined;
		}
	};
	const append = (output: PerceptionOutput) => {
		if (parsed.markdown) parsed.markdown += "\n\n";
		const offset = parsed.markdown.length;
		parsed.markdown += output.text;
		parsed.sources.push(
			...output.sources.map((source) => ({
				...source,
				markdownStart: source.markdownStart + offset,
				markdownEnd: source.markdownEnd + offset,
			})),
		);
		parsed.sections.push({ text: output.text, page: output.sources[0]?.page });
		parsed.diagnostics.push(...output.diagnostics);
	};
	const derive = async (
		kind: PerceptualRepresentation["kind"],
		ordinal: number,
		endpoint: PerceptionEndpoint,
		generate: () => Promise<PerceptionOutput>,
	): Promise<PerceptionOutput> => {
		const id = createHash("sha256")
			.update(JSON.stringify([document.id, document.contentVersion ?? 1, kind, ordinal, endpoint.fingerprint]))
			.digest("hex");
		const cached = previous.find((value) => value.id === id && value.contentHash === document.sha256);
		if (cached)
			return {
				text: cached.text,
				sources: cached.sources,
				diagnostics: [
					`已复用 ${kind} 派生结果（内容与模型指纹一致）。`,
					...(kind === "model_description" ? ["图像描述由模型生成，尚未经用户确认。"] : []),
				],
			};
		const output = await generate();
		signal.throwIfAborted();
		const value: PerceptualRepresentation = {
			id,
			projectId: document.projectId,
			documentId: document.id,
			contentVersion: document.contentVersion ?? 1,
			contentHash: document.sha256,
			kind,
			ordinal,
			modelFingerprint: endpoint.fingerprint,
			text: output.text,
			sources: output.sources,
			createdAt: new Date().toISOString(),
		};
		await options.retain(value);
		await options.repository.saveRepresentation(value);
		return output;
	};
	const readImage = async (value: PerceptionImage, ordinal: number, total: number) => {
		let text = "";
		const sources: KnowledgeSource[] = [];
		const ocr = await capability("ocr");
		if (ocr) {
			await options.onProgress("ocr", ordinal - 1, total);
			try {
				const output = await derive("ocr", ordinal, ocr, () => options.adapter.ocr(value, ocr, signal));
				append(output);
				text += output.text;
				sources.push(...output.sources);
			} catch (error) {
				signal.throwIfAborted();
				parsed.diagnostics.push(error instanceof WorkbenchError ? error.message : "OCR 失败，原件已保留");
			}
		}
		// Descriptions are on by default for uploaded images; scanned pages need an explicit request.
		const vision = image || document.describeScans ? await capability("vision") : undefined;
		if (vision) {
			await options.onProgress("describing", ordinal - 1, total);
			try {
				const output = await derive("model_description", ordinal, vision, () =>
					options.adapter.describe(value, vision, signal),
				);
				append(output);
				sources.push(
					...output.sources.map((source) => ({
						...source,
						markdownStart: source.markdownStart + text.length + 1,
						markdownEnd: source.markdownEnd + text.length + 1,
					})),
				);
				text += `\n${output.text}`;
			} catch (error) {
				signal.throwIfAborted();
				parsed.diagnostics.push(error instanceof WorkbenchError ? error.message : "图像描述失败，原件已保留");
			}
		}
		await options.onImage(value, text, sources);
		await options.onProgress(vision ? "describing" : "ocr", ordinal, total);
	};
	if (image) await readImage(await prepareImage(bytes), 1, 1);
	else if (audio) {
		const format = validateAudio(bytes, document.name);
		const endpoint = await capability("asr");
		if (endpoint) {
			await options.onProgress("transcribing", 0, 1);
			append(
				await derive("transcript", 1, endpoint, () => options.adapter.transcribe(bytes, format, endpoint, signal)),
			);
			await options.onProgress("transcribing", 1, 1);
		}
	} else if (parsed.scanPages?.length) {
		await renderScannedPages(bytes, parsed.scanPages, signal, async (value, rendered) => {
			await options.retainPage(value.page!, rendered);
			await readImage(value, value.page!, parsed.pageCount ?? parsed.scanPages!.length);
		});
		parsed.diagnostics = parsed.diagnostics.filter((value) => !value.includes("未执行 OCR"));
	}
	signal.throwIfAborted();
	if (!parsed.markdown.trim())
		throw new WorkbenchError(
			"external_failure",
			parsed.diagnostics.length
				? `没有可检索的派生正文：${[...new Set(parsed.diagnostics)].join("；")}`
				: "没有识别到可检索正文，原件已保留",
		);
	if (parsed.markdown.length > 4_000_000)
		throw new WorkbenchError("invalid_input", "派生正文超过 400 万字符，请拆分上传");
	parsed.diagnostics = [...new Set(parsed.diagnostics)];
	return parsed;
}
