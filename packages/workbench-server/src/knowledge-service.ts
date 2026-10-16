import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, relative } from "node:path";
import {
	type KnowledgeChunk,
	type KnowledgeDerivedDocument,
	type KnowledgeDocument,
	type KnowledgeHit,
	type KnowledgeRepository,
	type KnowledgeSearchResult,
	type KnowledgeSettings,
	type KnowledgeStatus,
	type PathPolicy,
	type PerceptualRepresentation,
	type PerceptualVector,
	type Project,
	WorkbenchError,
	type WorkbenchPaths,
	writeTextAtomically,
} from "@earendil-works/workbench-core";
import type { RuntimeModelRef } from "@earendil-works/workbench-runtime";
import {
	CHUNKER_VERSION,
	DEFAULT_KNOWLEDGE_SETTINGS,
	splitDocument,
	validateKnowledgeSettings,
} from "./knowledge-chunker.ts";
import { descriptionReview, reviewedDiagnostics, reviewedSources } from "./knowledge-description-review.ts";
import {
	type DocumentPassage,
	documentMimeType,
	MAX_DOCUMENT_BYTES,
	type ParsedDocument,
	TEXT_EXTENSIONS,
} from "./knowledge-document-parser.ts";
import { DEFAULT_EMBEDDING_ENV_FILE, type EmbeddingConfig, KnowledgeEmbeddingClient } from "./knowledge-embedding.ts";
import { generateHyde } from "./knowledge-hyde.ts";
import { PARSER_FINGERPRINT } from "./knowledge-markdown.ts";
import { expandQueries, type QueryContext, type QueryGenerator } from "./knowledge-mqe.ts";
import { fuseKnowledge, selectKnowledgeContext } from "./knowledge-retrieval.ts";
import {
	encodingTokenizer,
	type KnowledgeTokenizer,
	loadKnowledgeTokenizer,
	withKnowledgeTokenizer,
} from "./knowledge-tokenizer.ts";
import { MemoryEmbeddingScope } from "./memory-embedding.ts";
import { BailianPerceptionAdapter, type PerceptionAdapter } from "./perception-adapter.ts";
import { parsePerceptualDocument } from "./perception-parser.ts";

const SKIP_DIRECTORIES = new Set(["node_modules", "dist", "build", "coverage", "vendor", "target", "__pycache__"]);
interface DocumentJob {
	controller: AbortController;
	completion: Promise<void>;
	started: boolean;
}
export interface KnowledgeServiceOptions {
	paths: WorkbenchPaths;
	embeddingEnvFile?: string;
	fetcher?: typeof fetch;
	onError?: (message: string, documentId: string) => Promise<void>;
	generateQueries?: (prompt: string, signal: AbortSignal, model?: RuntimeModelRef) => Promise<string | undefined>;
	generateHypothesis?: (prompt: string, signal: AbortSignal, model?: RuntimeModelRef) => Promise<string | undefined>;
}
export interface KnowledgeSearchOptions {
	embeddingScope?: MemoryEmbeddingScope;
	context?: QueryContext[];
	model?: RuntimeModelRef;
	generate?: QueryGenerator;
	generateHypothesis?: QueryGenerator;
}
interface IndexConfiguration {
	embedding: EmbeddingConfig;
	tokenizer: KnowledgeTokenizer;
	settings: KnowledgeSettings;
	chunkerFingerprint: string;
	fingerprint: string;
}
function digest(value: string | Buffer): string {
	return createHash("sha256").update(value).digest("hex");
}

function chunkConfigurationFingerprint(settings: KnowledgeSettings): string {
	return digest(
		JSON.stringify([CHUNKER_VERSION, settings.maxChunkTokens, settings.minChunkTokens, settings.overlapTokens]),
	);
}

function keywordIndexFingerprint(settings: KnowledgeSettings): string {
	return digest(
		JSON.stringify([
			"keyword-only",
			PARSER_FINGERPRINT,
			chunkConfigurationFingerprint(settings),
			encodingTokenizer("cl100k_base").fingerprint,
		]),
	);
}

export class KnowledgeService {
	private readonly indexing = new Map<string, Promise<KnowledgeStatus>>();
	private readonly uploads = new Map<string, Promise<void>>();
	private readonly jobs = new Map<string, DocumentJob>();
	private readonly descriptionReviews = new Map<string, Promise<KnowledgeDocument>>();
	private readonly queues = new Map<string, Promise<void>>();
	private readonly repository: KnowledgeRepository;
	private readonly pathPolicy: PathPolicy;
	private readonly options: KnowledgeServiceOptions;
	private readonly embeddings: KnowledgeEmbeddingClient;
	private readonly perception: PerceptionAdapter;
	private stopping = false;
	private readonly shutdown = new AbortController();
	constructor(repository: KnowledgeRepository, pathPolicy: PathPolicy, options: KnowledgeServiceOptions) {
		this.repository = repository;
		this.pathPolicy = pathPolicy;
		this.options = options;
		this.embeddings = new KnowledgeEmbeddingClient(options.embeddingEnvFile, options.fetcher);
		this.perception = new BailianPerceptionAdapter(options.embeddingEnvFile, options.fetcher);
	}
	embeddingScope(): MemoryEmbeddingScope {
		return new MemoryEmbeddingScope(this.embeddings);
	}
	async isBusy(projectId: string): Promise<boolean> {
		return (
			this.indexing.has(projectId) ||
			this.uploads.has(projectId) ||
			this.queues.has(projectId) ||
			(await this.repository.listDocuments(projectId)).some(
				(document) => this.jobs.has(document.id) || this.descriptionReviews.has(document.id),
			)
		);
	}
	async settings(project: Project): Promise<KnowledgeSettings> {
		return validateKnowledgeSettings((await this.repository.getSettings(project.id)) ?? DEFAULT_KNOWLEDGE_SETTINGS);
	}
	async configure(project: Project, settings: unknown): Promise<KnowledgeStatus> {
		if (
			this.stopping ||
			this.indexing.has(project.id) ||
			(await this.repository.listDocuments(project.id)).some((document) => this.jobs.has(document.id))
		)
			throw new WorkbenchError("conflict", "请等待项目索引任务结束后修改参数");
		await this.repository.saveSettings(project.id, validateKnowledgeSettings(settings));
		return this.status(project);
	}
	private async configuration(project: Project): Promise<IndexConfiguration> {
		const embedding = await this.embeddings.config();
		const tokenizer = await loadKnowledgeTokenizer(
			embedding,
			dirname(this.options.embeddingEnvFile ?? DEFAULT_EMBEDDING_ENV_FILE),
			(text, signal) => this.embeddings.measure(embedding, text, signal),
		);
		const settings = await this.settings(project);
		const chunkerFingerprint = chunkConfigurationFingerprint(settings);
		return {
			embedding,
			tokenizer,
			settings,
			chunkerFingerprint,
			fingerprint: digest(
				[embedding.fingerprint, PARSER_FINGERPRINT, chunkerFingerprint, tokenizer.fingerprint].join("\n"),
			),
		};
	}
	private async perceptionFingerprint(document: KnowledgeDocument): Promise<string | undefined> {
		const names =
			document.mimeType.startsWith("image/") || document.mimeType === "application/pdf"
				? (["ocr", "vision", "multimodal"] as const)
				: document.mimeType.startsWith("audio/")
					? (["asr"] as const)
					: [];
		if (!names.length) return undefined;
		const values = await Promise.all(
			names.map(async (name) => {
				try {
					return (await this.perception.configuration.endpoint(name)).fingerprint;
				} catch {
					return `${name}:missing`;
				}
			}),
		);
		return digest(values.join("\n"));
	}
	async status(project: Project): Promise<KnowledgeStatus> {
		const files = await this.repository.listFiles(project.id);
		const documents = await this.repository.listDocuments(project.id);
		const perceptualStale = (
			await Promise.all(
				documents
					.filter((value) => value.status === "ready" && !value.supersededBy)
					.map(async (value) => value.perceptionFingerprint !== (await this.perceptionFingerprint(value))),
			)
		).filter(Boolean).length;
		let config: EmbeddingConfig | undefined;
		let diagnostic: string | undefined;
		let index: IndexConfiguration | undefined;
		try {
			config = await this.embeddings.config();
			index = await this.configuration(project);
			if (files.some((file) => file.indexFingerprint !== index?.fingerprint))
				diagnostic = "解析、分块、tokenizer 或 Embedding 配置已改变，请重新建立索引";
			if (index.tokenizer.resolve)
				diagnostic = `${diagnostic ? `${diagnostic}；` : ""}已启用供应商实际 Token 计量，分块与引用预算会产生额外 Embedding 请求`;
		} catch (error) {
			diagnostic = error instanceof WorkbenchError ? error.message : "系统 Embedding 配置不可用";
		}
		return {
			capabilities: await this.perception.configuration.capabilities(),
			configured: Boolean(config),
			model: config?.model,
			fileCount: files.length,
			chunkCount: files.reduce((sum, file) => sum + file.chunkCount, 0),
			indexedAt: files
				.map((file) => file.indexedAt)
				.sort()
				.at(-1),
			diagnostic: perceptualStale
				? `${diagnostic ? `${diagnostic}；` : ""}感知模型或空间修订已改变，${perceptualStale} 个资料需要重新处理`
				: diagnostic,
			vectorEngine: "sqlite-vec",
			documentCount: documents.length,
			processingCount: documents.filter((doc) => doc.status === "queued" || doc.status === "processing").length,
			failedCount: documents.filter((doc) => doc.status === "failed").length,
			settings: await this.settings(project),
			tokenizer: index?.tokenizer.name,
			staleFileCount: Math.max(
				perceptualStale,
				files.filter((file) => file.indexFingerprint !== index?.fingerprint).length,
			),
		};
	}
	async listDocuments(project: Project): Promise<KnowledgeDocument[]> {
		return this.repository.listDocuments(project.id);
	}
	private async getDocument(project: Project, id: string): Promise<KnowledgeDocument> {
		const document = await this.repository.getDocument(project.id, id);
		if (!document) throw new WorkbenchError("not_found", "该项目的知识文档不存在");
		return document;
	}
	private async documentFile(project: Project, document: KnowledgeDocument): Promise<string> {
		const path = join(this.options.paths.project(project.slug).knowledgeDir, "uploads", document.id, document.name);
		return (await this.pathPolicy.requireWorkspace(relative(this.options.paths.workspace, path))).realPath;
	}
	async upload(
		project: Project,
		name: string,
		bytes: Buffer,
		source: KnowledgeDocument["source"] = { kind: "upload" },
	): Promise<KnowledgeDocument> {
		const operation = (this.uploads.get(project.id) ?? Promise.resolve()).then(() =>
			this.uploadNow(project, name, bytes, source),
		);
		const settled = operation.then(
			() => undefined,
			() => undefined,
		);
		this.uploads.set(project.id, settled);
		try {
			return await operation;
		} finally {
			if (this.uploads.get(project.id) === settled) this.uploads.delete(project.id);
		}
	}
	async snapshot(project: Project, path: string): Promise<KnowledgeDocument> {
		const safe = await this.pathPolicy.requireProjectFile(project.sourcePath ?? project.workspacePath, path);
		return this.upload(project, basename(safe.realPath), await readFile(safe.realPath), {
			kind: "snapshot",
			path: path.replaceAll("\\", "/"),
		});
	}
	private async uploadNow(
		project: Project,
		name: string,
		bytes: Buffer,
		source: KnowledgeDocument["source"],
	): Promise<KnowledgeDocument> {
		if (this.stopping) throw new WorkbenchError("conflict", "知识库正在关闭");
		if (
			!name.trim() ||
			name.length > 180 ||
			/[\\/\x00-\x1f<>:"|?*]/u.test(name) ||
			name.startsWith(".") ||
			/[. ]$/u.test(name) ||
			/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(name)
		)
			throw new WorkbenchError("invalid_input", "文档名称无效");
		const mimeType = documentMimeType(name);
		if (!bytes.length || bytes.length > MAX_DOCUMENT_BYTES)
			throw new WorkbenchError("invalid_input", "文档必须为非空文件，且不超过 20 MiB");
		const documents = await this.repository.listDocuments(project.id);
		const sha256 = digest(bytes);
		const existing = documents.find((entry) => entry.sha256 === sha256 && !entry.supersededBy);
		if (existing) return existing;
		if (
			documents.length >= 250 ||
			documents.reduce((sum, document) => sum + document.size, 0) + bytes.length > 500 * 1024 * 1024
		)
			throw new WorkbenchError(
				"invalid_input",
				"项目知识库最多 250 个文档、500 MiB 原文，请删除不需要的资料后再上传",
			);
		const timestamp = new Date().toISOString();
		const previous =
			source?.kind === "snapshot"
				? documents
						.filter((value) => value.source?.path === source.path)
						.sort((a, b) => (b.contentVersion ?? 1) - (a.contentVersion ?? 1))[0]
				: undefined;
		const document: KnowledgeDocument = {
			contentVersion: previous ? (previous.contentVersion ?? 1) + 1 : 1,
			source,
			id: randomUUID(),
			projectId: project.id,
			name,
			path: "",
			mimeType,
			size: bytes.length,
			sha256,
			status: "queued",
			stage: "queued",
			chunkCount: 0,
			processedChunks: 0,
			createdAt: timestamp,
			updatedAt: timestamp,
		};
		document.path = `@knowledge/${document.id}/${name}`;
		if (source?.indexed && source.path) document.path = source.path;
		const target = await this.documentFile(project, document);
		await mkdir(dirname(target), { recursive: true });
		const temporary = `${target}.upload`;
		try {
			await writeFile(temporary, bytes, { flag: "wx" });
			await rename(temporary, target);
			await this.repository.saveDocument(document);
		} catch (error) {
			await rm(temporary, { force: true });
			await rm(target, { force: true });
			throw error;
		}
		if (previous && previous.id !== document.id) {
			const historicalPath = `@knowledge/${previous.id}/${previous.name}`;
			if (previous.path === document.path) {
				const derived = await this.repository.getDerived(project.id, previous.path);
				if (derived) await this.repository.saveDerived({ ...derived, path: historicalPath });
			}
			await this.repository.saveDocument({
				...previous,
				path: previous.path === document.path ? historicalPath : previous.path,
				supersededBy: document.id,
				updatedAt: timestamp,
			});
			await this.repository.deleteFile(project.id, previous.path);
			await this.repository.replacePerceptualVectors(project.id, previous.id, []);
		}
		this.schedule(project, document);
		return document;
	}
	private schedule(project: Project, document: KnowledgeDocument): void {
		if (this.stopping || this.jobs.has(document.id)) return;
		const controller = new AbortController();
		const previous = this.queues.get(project.id) ?? Promise.resolve();
		const completion = previous
			.then(() => {
				if (controller.signal.aborted && !this.stopping) return;
				const job = this.jobs.get(document.id);
				if (job?.controller === controller) job.started = true;
				return this.process(project, document, controller.signal);
			})
			.catch((error: unknown) =>
				this.reportError(error instanceof WorkbenchError ? error.message : "知识文档处理存储失败", document.id),
			)
			.finally(() => {
				if (this.jobs.get(document.id)?.controller === controller) this.jobs.delete(document.id);
				if (this.queues.get(project.id) === completion) this.queues.delete(project.id);
			});
		this.jobs.set(document.id, { controller, completion, started: false });
		this.queues.set(project.id, completion);
	}
	private async reportError(message: string, documentId: string): Promise<void> {
		try {
			await this.options.onError?.(message, documentId);
		} catch {
			process.stderr.write(`知识文档 ${documentId} 的诊断日志写入失败\n`);
		}
	}
	private async process(project: Project, document: KnowledgeDocument, signal: AbortSignal): Promise<void> {
		let progress = { ...document };
		const nativeVectors: PerceptualVector[] = [];
		const nativeDiagnostics: string[] = [];
		try {
			signal.throwIfAborted();
			progress = {
				...progress,
				status: "processing",
				stage: "parsing",
				error: undefined,
				processingState: undefined,
				perceptionFingerprint: await this.perceptionFingerprint(document),
				updatedAt: new Date().toISOString(),
			};
			await this.repository.saveDocument(progress);
			const path = await this.documentFile(project, document);
			const bytes = await readFile(path);
			if (digest(bytes) !== document.sha256)
				throw new WorkbenchError("conflict", "原文档已被修改，请重新上传该文档");
			await this.restoreRepresentations(project, document, signal);
			const parsed = await parsePerceptualDocument(path, document, signal, {
				repository: this.repository,
				adapter: this.perception,
				onProgress: async (stage, completed, total) => {
					progress = {
						...progress,
						processingStage: stage,
						progress: { completed, total },
						updatedAt: new Date().toISOString(),
					};
					await this.repository.saveDocument(progress);
				},
				retain: async (value) => {
					const directory = await this.derivedDirectory(project, document);
					await writeTextAtomically(join(directory, `${value.id}.json`), JSON.stringify(value, null, 2));
				},
				retainPage: async (page, bytes) => {
					const directory = await this.derivedDirectory(project, document);
					const target = join(directory, `page-${page}.png`);
					await writeFile(`${target}.tmp`, bytes);
					await rename(`${target}.tmp`, target);
				},
				onImage: async (image, text, sources) => {
					try {
						const endpoint = await this.perception.configuration.endpoint("multimodal");
						const vector = await this.perception.embed({ image: image.dataUrl }, endpoint, signal);
						nativeVectors.push({
							id: digest(JSON.stringify([document.id, image.page ?? 1, endpoint.spaceId])),
							projectId: project.id,
							documentId: document.id,
							contentVersion: document.contentVersion ?? 1,
							spaceId: endpoint.spaceId,
							vector,
							text: text || `原始图片：${document.name}`,
							sources: [
								...sources,
								{
									kind: "image",
									representation: "original_image",
									origin: "original",
									page: image.page,
									markdownStart: 0,
									markdownEnd: text.length,
								},
							],
						});
					} catch (error) {
						signal.throwIfAborted();
						nativeDiagnostics.push(
							error instanceof WorkbenchError ? error.message : "图文向量不可用，保留文字检索",
						);
					}
				},
			});
			parsed.diagnostics.push(...new Set(nativeDiagnostics));
			if (progress.perceptionFingerprint !== (await this.perceptionFingerprint(document)))
				throw new WorkbenchError("conflict", "感知配置在处理期间改变，请重试；未发布不一致的派生索引");
			await this.saveDerived(project, document.path, document.sha256, parsed, signal);
			const review = descriptionReview(progress, await this.repository.getDerived(project.id, document.path));
			parsed.diagnostics = reviewedDiagnostics(parsed.diagnostics, review?.reviewedAt);
			progress = {
				...progress,
				diagnostics: parsed.diagnostics,
				descriptionReview: review?.reviewedAt ? progress.descriptionReview : undefined,
			};
			let index: IndexConfiguration | undefined;
			try {
				index = await this.configuration(project);
			} catch (error) {
				// Text RAG must never substitute a guessed tokenizer or invalidate a committed index on retry.
				if (
					!document.mimeType.startsWith("image/") &&
					!document.mimeType.startsWith("audio/") &&
					!parsed.scanPages?.length &&
					(await this.embeddings.config().then(
						() => true,
						() => false,
					))
				)
					throw error;
				parsed.diagnostics.push(error instanceof WorkbenchError ? error.message : "文本 Embedding 配置不可用");
				parsed.diagnostics.push("派生正文已保存，本次仅建立关键词索引；没有生成文本向量。");
			}
			if (!index) {
				const settings = await this.settings(project);
				const fingerprint = keywordIndexFingerprint(settings);
				const passages = splitDocument(parsed, encodingTokenizer("cl100k_base"), settings, signal);
				await this.repository.replaceFile(
					{
						projectId: project.id,
						path: document.path,
						contentHash: digest(`${fingerprint}\n${document.sha256}`),
						modelFingerprint: "keyword-only",
						indexFingerprint: fingerprint,
						chunkerFingerprint: chunkConfigurationFingerprint(settings),
						tokenizerFingerprint: encodingTokenizer("cl100k_base").fingerprint,
						parserFingerprint: PARSER_FINGERPRINT,
						chunkCount: passages.length,
						indexedAt: new Date().toISOString(),
					},
					passages.map((passage, ordinal) => ({
						...passage,
						id: digest(JSON.stringify([project.id, document.path, ordinal, passage.text])),
						projectId: project.id,
						path: document.path,
						ordinal,
						vector: [],
					})),
				);
				await this.repository.replacePerceptualVectors(project.id, document.id, nativeVectors);
				await this.repository.saveDocument({
					...progress,
					status: "ready",
					stage: "ready",
					processingStage: undefined,
					processingState: "partial",
					chunkCount: passages.length,
					processedChunks: passages.length,
					pageCount: parsed.pageCount,
					diagnostics: parsed.diagnostics,
					updatedAt: new Date().toISOString(),
				});
				return;
			}
			const passages = await withKnowledgeTokenizer(
				index.tokenizer,
				() => splitDocument(parsed, index.tokenizer, index.settings, signal),
				signal,
			);
			progress = {
				...progress,
				stage: "embedding",
				processingStage: "embedding",
				chunkCount: passages.length,
				pageCount: parsed.pageCount,
				diagnostics: parsed.diagnostics,
				processedChunks: 0,
				updatedAt: new Date().toISOString(),
			};
			await this.repository.saveDocument(progress);
			await this.indexPassages(
				project.id,
				document.path,
				digest(`${index.fingerprint}\n${document.sha256}`),
				index,
				passages,
				signal,
				async (count) => {
					progress = { ...progress, processedChunks: count, updatedAt: new Date().toISOString() };
					await this.repository.saveDocument(progress);
				},
			);
			await this.repository.replacePerceptualVectors(project.id, document.id, nativeVectors);
			await this.repository.saveDocument({
				...progress,
				status: "ready",
				stage: "ready",
				processingStage: undefined,
				processingState: parsed.diagnostics.some((value) =>
					/缺少|需要独立|已关闭|失败|不可用|HTTP|未发布/u.test(value),
				)
					? "partial"
					: undefined,
				updatedAt: new Date().toISOString(),
			});
		} catch (error) {
			if (signal.aborted && this.stopping) {
				await this.repository.saveDocument({
					...progress,
					status: progress.processingStage === "transcribing" ? "failed" : "queued",
					stage: progress.processingStage === "transcribing" ? "failed" : "queued",
					processingState: "interrupted",
					processedChunks: 0,
					error:
						progress.processingStage === "transcribing"
							? "ASR 连接已中断；重试将重新转写整个文件并替换结果。"
							: undefined,
					updatedAt: new Date().toISOString(),
				});
				return;
			}
			const message = signal.aborted
				? "文档处理已取消"
				: error instanceof WorkbenchError
					? error.message
					: "文档处理失败，请检查格式后重试";
			await this.repository.saveDocument({
				...progress,
				status: "failed",
				stage: "failed",
				processingState: signal.aborted
					? "cancelled"
					: /缺少|需要独立|未配置|已关闭/u.test(message)
						? "missing_capability"
						: /原文档已被修改/u.test(message)
							? "stale"
							: undefined,
				error: message,
				updatedAt: new Date().toISOString(),
			});
			await this.reportError(message, document.id);
		}
	}
	private async derivedDirectory(project: Project, document: KnowledgeDocument): Promise<string> {
		const directory = (
			await this.pathPolicy.requireWorkspace(
				relative(
					this.options.paths.workspace,
					join(dirname(await this.documentFile(project, document)), "derived"),
				),
			)
		).realPath;
		await mkdir(directory, { recursive: true });
		return directory;
	}
	private async restoreRepresentations(
		project: Project,
		document: KnowledgeDocument,
		signal: AbortSignal,
	): Promise<void> {
		const directory = await this.derivedDirectory(project, document);
		const existing = new Set(
			(await this.repository.listRepresentations(project.id, document.id)).map((value) => value.id),
		);
		for (const name of await readdir(directory)) {
			signal.throwIfAborted();
			if (!/^[a-f0-9]{64}\.json$/u.test(name) || existing.has(name.slice(0, -5))) continue;
			const path = await this.pathPolicy.requireWorkspace(
				relative(this.options.paths.workspace, join(directory, name)),
			);
			if ((await stat(path.realPath)).size > 16 * 1024 * 1024) continue;
			let value: PerceptualRepresentation;
			try {
				value = JSON.parse(await readFile(path.realPath, "utf8")) as PerceptualRepresentation;
			} catch {
				continue;
			}
			if (
				!value ||
				value.projectId !== project.id ||
				value.documentId !== document.id ||
				value.contentHash !== document.sha256 ||
				value.contentVersion !== (document.contentVersion ?? 1) ||
				!["ocr", "transcript", "model_description"].includes(value.kind) ||
				!Number.isInteger(value.ordinal) ||
				value.ordinal < 1 ||
				typeof value.modelFingerprint !== "string" ||
				typeof value.text !== "string" ||
				value.text.length > 4_000_000 ||
				!Array.isArray(value.sources) ||
				value.sources.some(
					(source) =>
						!source ||
						!Number.isInteger(source.markdownStart) ||
						!Number.isInteger(source.markdownEnd) ||
						source.markdownStart < 0 ||
						source.markdownEnd > value.text.length ||
						source.markdownEnd < source.markdownStart,
				)
			)
				continue;
			const id = digest(
				JSON.stringify([document.id, value.contentVersion, value.kind, value.ordinal, value.modelFingerprint]),
			);
			if (value.id === id && name === `${id}.json`) await this.repository.saveRepresentation(value);
		}
	}
	private async indexPassages(
		projectId: string,
		path: string,
		contentHash: string,
		configuration: IndexConfiguration,
		passages: DocumentPassage[],
		signal?: AbortSignal,
		onProgress?: (count: number) => Promise<void>,
	): Promise<void> {
		const chunks: KnowledgeChunk[] = [];
		let dimension: number | undefined;
		for (let offset = 0; offset < passages.length; offset += 16) {
			const batch = passages.slice(offset, offset + 16);
			const vectors = await this.embeddings.embed(
				configuration.embedding,
				batch.map((passage) => passage.text),
				signal,
			);
			if (dimension !== undefined && vectors.some((vector) => vector.length !== dimension))
				throw new WorkbenchError("external_failure", "Embedding 服务在处理过程中改变了向量维度");
			dimension = vectors[0]?.length;
			chunks.push(
				...batch.map((passage, index) => ({
					projectId,
					path,
					ordinal: offset + index,
					id: digest(
						JSON.stringify([
							projectId,
							path,
							offset + index,
							passage.markdownStart,
							passage.markdownEnd,
							passage.text,
						]),
					),
					...passage,
					vector: vectors[index],
				})),
			);
			await onProgress?.(chunks.length);
		}
		signal?.throwIfAborted();
		await this.repository.replaceFile(
			{
				projectId,
				path,
				contentHash,
				modelFingerprint: configuration.embedding.fingerprint,
				indexFingerprint: configuration.fingerprint,
				parserFingerprint: PARSER_FINGERPRINT,
				chunkerFingerprint: configuration.chunkerFingerprint,
				tokenizerFingerprint: configuration.tokenizer.fingerprint,
				chunkCount: chunks.length,
				indexedAt: new Date().toISOString(),
			},
			chunks,
		);
	}
	async retryDocument(project: Project, id: string, describeScans?: boolean): Promise<KnowledgeDocument> {
		if (this.stopping) throw new WorkbenchError("conflict", "知识库正在关闭");
		if (this.descriptionReviews.has(id)) throw new WorkbenchError("conflict", "图像描述核对正在保存，请稍后重试");
		const document = await this.getDocument(project, id);
		const job = this.jobs.get(id);
		if (job) {
			if (document.status !== "failed" && document.status !== "ready")
				throw new WorkbenchError("conflict", "文档仍在处理中");
			// A terminal status can be visible before diagnostic persistence and queue cleanup finish.
			await job.completion;
			if (this.stopping) throw new WorkbenchError("conflict", "知识库正在关闭");
		}
		const queued: KnowledgeDocument = {
			...document,
			describeScans: describeScans ?? document.describeScans,
			status: "queued",
			stage: "queued",
			processedChunks: 0,
			error: undefined,
			updatedAt: new Date().toISOString(),
		};
		await this.repository.saveDocument(queued);
		this.schedule(project, queued);
		return queued;
	}
	async deleteDocument(project: Project, id: string): Promise<void> {
		if (this.descriptionReviews.has(id)) throw new WorkbenchError("conflict", "图像描述核对正在保存，请稍后删除");
		const document = await this.getDocument(project, id);
		if (await this.repository.documentReferenceCount(project.id, id))
			throw new WorkbenchError("conflict", "原件仍被事实、情景或检查点引用；可仅删除检索索引，保留证据原件。");
		const job = this.jobs.get(id);
		job?.controller.abort();
		if (job?.started) await job.completion;
		else if (job) this.jobs.delete(id);
		const path = await this.documentFile(project, document);
		await rm(path, { force: true });
		const derived = (
			await this.pathPolicy.requireWorkspace(relative(this.options.paths.workspace, join(dirname(path), "derived")))
		).realPath;
		for (const name of await readdir(derived).catch(() => [])) {
			if (
				/^(?:document\.md|source-map\.json|description-review\.json|[a-f0-9]{64}\.json|page-\d+\.png(?:\.tmp)?)$/u.test(
					name,
				)
			)
				await rm(join(derived, name), { force: true });
		}
		await rmdir(derived).catch((error: unknown) => {
			if (!(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")) throw error;
		});
		await this.repository.deleteDocument(project.id, id);
		await rmdir(dirname(path));
	}
	async original(project: Project, id: string): Promise<{ document: KnowledgeDocument; bytes: Buffer }> {
		const document = await this.getDocument(project, id);
		const bytes = await readFile(await this.documentFile(project, document));
		if (digest(bytes) !== document.sha256) {
			await this.repository.deleteFile(project.id, document.path);
			await this.repository.replacePerceptualVectors(project.id, id, []);
			await this.repository.saveDocument({
				...document,
				status: "failed",
				stage: "failed",
				processingState: "stale",
				error: "原件已改变，请重新上传；旧索引已失效。",
				updatedAt: new Date().toISOString(),
			});
			throw new WorkbenchError("conflict", "原件已改变，请重新上传；旧索引已失效。");
		}
		return { document, bytes };
	}
	async deleteIndex(project: Project, id: string): Promise<void> {
		if (this.descriptionReviews.has(id)) throw new WorkbenchError("conflict", "图像描述核对正在保存，请稍后删除索引");
		const document = await this.getDocument(project, id);
		if (this.jobs.has(id)) await this.cancelDocument(project, id);
		await this.repository.deleteFile(project.id, document.path);
		await this.repository.replacePerceptualVectors(project.id, id, []);
		await this.repository.saveDocument({
			...document,
			status: "failed",
			stage: "failed",
			error: "检索索引已删除，原件和派生正文仍保留；可重试重建。",
			updatedAt: new Date().toISOString(),
		});
	}
	async pageImage(project: Project, id: string, page: number): Promise<Buffer> {
		const document = await this.getDocument(project, id);
		if (!Number.isInteger(page) || page < 1 || page > (document.pageCount ?? 0))
			throw new WorkbenchError("invalid_input", "PDF 页码无效");
		await this.original(project, id);
		const path = join(await this.derivedDirectory(project, document), `page-${page}.png`);
		try {
			return await readFile(path);
		} catch {
			throw new WorkbenchError("not_found", "该页没有已保留的扫描图像");
		}
	}
	async preview(
		project: Project,
		id: string,
	): Promise<{
		document: KnowledgeDocument;
		passages: Array<DocumentPassage & { ordinal: number }>;
		derived?: KnowledgeDerivedDocument;
		descriptionReview?: { fingerprint: string; reviewedAt?: string };
	}> {
		const document = await this.getDocument(project, id);
		const chunks = await this.repository.listChunks(project.id);
		const derived = await this.repository.getDerived(project.id, document.path);
		const review = descriptionReview(document, derived);
		return {
			document,
			descriptionReview: review,
			derived: derived
				? {
						...derived,
						sources: reviewedSources(derived.sources, review?.reviewedAt) ?? [],
						diagnostics: reviewedDiagnostics(derived.diagnostics, review?.reviewedAt),
					}
				: undefined,
			passages: chunks
				.filter((chunk) => chunk.path === document.path)
				.slice(0, 50)
				.map(({ vector: _vector, projectId: _projectId, path: _path, ...passage }) => ({
					...passage,
					sources: reviewedSources(passage.sources, review?.reviewedAt),
				})),
		};
	}
	async confirmDescription(project: Project, id: string, fingerprint: string): Promise<KnowledgeDocument> {
		if (this.stopping || this.descriptionReviews.has(id))
			throw new WorkbenchError("conflict", "知识库关闭中或图像描述核对正在保存");
		const operation = this.confirmDescriptionNow(project, id, fingerprint).finally(() =>
			this.descriptionReviews.delete(id),
		);
		this.descriptionReviews.set(id, operation);
		return operation;
	}
	private async confirmDescriptionNow(project: Project, id: string, fingerprint: string): Promise<KnowledgeDocument> {
		const document = await this.getDocument(project, id);
		if (this.jobs.has(id) || document.status !== "ready")
			throw new WorkbenchError("conflict", "请等待资料处理完成后核对图像描述");
		const derived = await this.repository.getDerived(project.id, document.path);
		const review = descriptionReview(document, derived);
		if (!review || review.fingerprint !== fingerprint)
			throw new WorkbenchError("conflict", "图像描述已变化或尚未生成，请刷新并重新核对");
		await this.original(project, id);
		const reviewedAt = new Date().toISOString();
		const updated: KnowledgeDocument = {
			...document,
			descriptionReview: { fingerprint, reviewedAt },
			diagnostics: reviewedDiagnostics(document.diagnostics ?? [], reviewedAt),
			updatedAt: reviewedAt,
		};
		await writeTextAtomically(
			join(await this.derivedDirectory(project, document), "description-review.json"),
			JSON.stringify({ documentId: id, contentHash: document.sha256, fingerprint, reviewedAt }, null, 2),
		);
		await this.repository.saveDocument(updated);
		return updated;
	}
	async captions(project: Project, id: string): Promise<string> {
		const document = await this.getDocument(project, id);
		await this.original(project, id);
		const derived = await this.repository.getDerived(project.id, document.path);
		const values =
			derived?.contentHash === document.sha256
				? derived.sources
						.filter(
							(value) => value.kind === "transcript" && value.beginMs !== undefined && value.endMs !== undefined,
						)
						.sort((a, b) => a.beginMs! - b.beginMs!)
				: [];
		const time = (ms: number) => {
			const seconds = Math.floor(ms / 1000);
			return `${String(Math.floor(seconds / 3600)).padStart(2, "0")}:${String(Math.floor(seconds / 60) % 60).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}.${String(Math.floor(ms % 1000)).padStart(3, "0")}`;
		};
		return `WEBVTT\n\n${values
			.map(
				(source, index) =>
					`${index + 1}\n${time(source.beginMs!)} --> ${time(source.endMs!)}\n${derived!.markdown.slice(source.markdownStart, source.markdownEnd).replace(/[<>]/gu, "").replace(/\r?\n/gu, " ")}\n`,
			)
			.join("\n")}`;
	}
	private async saveDerived(
		project: Project,
		path: string,
		contentHash: string,
		parsed: ParsedDocument,
		signal?: AbortSignal,
	): Promise<void> {
		signal?.throwIfAborted();
		const value: KnowledgeDerivedDocument = {
			projectId: project.id,
			path,
			contentHash,
			markdown: parsed.markdown,
			sources: parsed.sources,
			diagnostics: parsed.diagnostics,
			parserFingerprint: PARSER_FINGERPRINT,
		};
		const document = (await this.repository.listDocuments(project.id)).find((document) => document.path === path);
		const directory = (
			await this.pathPolicy.requireWorkspace(
				relative(
					this.options.paths.workspace,
					document
						? join(dirname(await this.documentFile(project, document)), "derived")
						: join(this.options.paths.project(project.slug).knowledgeDir, "derived", digest(path)),
				),
			)
		).realPath;
		await mkdir(directory, { recursive: true });
		await writeTextAtomically(join(directory, "document.md"), value.markdown);
		await writeTextAtomically(
			join(directory, "source-map.json"),
			JSON.stringify({ ...value, markdown: undefined }, null, 2),
		);
		signal?.throwIfAborted();
		await this.repository.saveDerived(value);
	}
	async cancelDocument(project: Project, id: string): Promise<KnowledgeDocument> {
		const document = await this.getDocument(project, id);
		const job = this.jobs.get(id);
		job?.controller.abort();
		if (job?.started) await job.completion;
		else if (job) {
			this.jobs.delete(id);
			await this.repository.saveDocument({
				...document,
				status: "failed",
				stage: "failed",
				processingState: "cancelled",
				error: "文档处理已取消",
				updatedAt: new Date().toISOString(),
			});
		}
		return this.getDocument(project, id);
	}
	async recover(projects: Project[]): Promise<void> {
		for (const document of await this.repository.listDocuments()) {
			if (!["queued", "processing"].includes(document.status)) continue;
			const project = projects.find((entry) => entry.id === document.projectId);
			if (project && document.status === "processing" && document.processingStage === "transcribing") {
				await this.repository.saveDocument({
					...document,
					status: "failed",
					stage: "failed",
					processingState: "interrupted",
					error: "ASR 在重启前中断，请重试整个文件；不会自动拼接未完成句段。",
					updatedAt: new Date().toISOString(),
				});
			} else if (project) this.schedule(project, document);
		}
	}
	async dispose(): Promise<void> {
		this.stopping = true;
		this.shutdown.abort();
		await Promise.all(this.uploads.values());
		await Promise.allSettled(this.descriptionReviews.values());
		for (const job of this.jobs.values()) job.controller.abort();
		await Promise.all(this.queues.values());
		await Promise.allSettled(this.indexing.values());
	}
	async index(project: Project, signal?: AbortSignal): Promise<KnowledgeStatus> {
		const active = this.indexing.get(project.id);
		if (active) return active;
		const operation = this.indexNow(
			project,
			signal ? AbortSignal.any([signal, this.shutdown.signal]) : this.shutdown.signal,
		).finally(() => this.indexing.delete(project.id));
		this.indexing.set(project.id, operation);
		return operation;
	}
	private async *files(root: string, uploadsDirectory: string, directory = ""): AsyncGenerator<string> {
		for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
			if (entry.name.startsWith(".") || entry.name === "@knowledge") continue;
			const path = join(directory, entry.name);
			if (
				entry.isDirectory() &&
				!SKIP_DIRECTORIES.has(entry.name) &&
				relative(uploadsDirectory, join(root, path)) !== ""
			)
				yield* this.files(root, uploadsDirectory, path);
			else if (
				entry.isFile() &&
				(TEXT_EXTENSIONS.has(extname(entry.name).toLowerCase()) ||
					[".pdf", ".docx", ".doc", ".png", ".jpg", ".jpeg", ".bmp", ".wav", ".mp3"].includes(
						extname(entry.name).toLowerCase(),
					))
			)
				yield path;
		}
	}
	private async indexNow(project: Project, signal?: AbortSignal): Promise<KnowledgeStatus> {
		const index = await this.configuration(project).catch(() => undefined);
		const keywordFingerprint = keywordIndexFingerprint(await this.settings(project));
		const root = project.sourcePath ?? project.workspacePath;
		const existing = new Map(
			(await this.repository.listFiles(project.id))
				.filter((file) => !file.path.startsWith("@knowledge/"))
				.map((file) => [file.path, file]),
		);
		const found = new Set<string>();
		let totalBytes = 0;
		let complete = true;
		for await (const relativePath of this.files(root, this.options.paths.project(project.slug).knowledgeDir)) {
			signal?.throwIfAborted();
			if (found.size >= 200 || totalBytes >= 100 * 1024 * 1024) {
				complete = false;
				break;
			}
			const path = relativePath.replaceAll("\\", "/");
			const safe = await this.pathPolicy.requireProjectFile(root, path);
			const metadata = await stat(safe.realPath);
			if (metadata.size > MAX_DOCUMENT_BYTES || !metadata.size) continue;
			found.add(path);
			totalBytes += metadata.size;
			const bytes = await readFile(safe.realPath);
			// Every source is snapshotted into the existing managed Knowledge store before parsing.
			await this.upload(project, basename(safe.realPath), bytes, { kind: "snapshot", path, indexed: true });
		}
		if (complete)
			for (const path of existing.keys()) if (!found.has(path)) await this.repository.deleteFile(project.id, path);
		const records = new Map((await this.repository.listFiles(project.id)).map((file) => [file.path, file]));
		const scheduled: DocumentJob[] = [];
		const abort = () => {
			for (const job of scheduled) job.controller.abort(signal?.reason);
		};
		signal?.addEventListener("abort", abort, { once: true });
		try {
			for (const document of await this.repository.listDocuments(project.id)) {
				signal?.throwIfAborted();
				if (document.supersededBy) continue;
				if (complete && document.source?.indexed && document.source.path && !found.has(document.source.path)) {
					await this.deleteIndex(project, document.id);
					await this.repository.saveDocument({
						...document,
						status: "failed",
						stage: "failed",
						processingState: "stale",
						error: "外部来源已删除，受管理原件仍保留；明确重试可重新检索快照。",
						updatedAt: new Date().toISOString(),
					});
					continue;
				}
				if (
					document.status === "ready" &&
					(index
						? records.get(document.path)?.contentHash === digest(`${index.fingerprint}\n${document.sha256}`)
						: records.get(document.path)?.indexFingerprint === keywordFingerprint) &&
					document.perceptionFingerprint === (await this.perceptionFingerprint(document))
				)
					continue;
				if (!this.jobs.has(document.id)) {
					await this.retryDocument(project, document.id);
					const job = this.jobs.get(document.id);
					if (job) scheduled.push(job);
				} else {
					const job = this.jobs.get(document.id);
					if (job) scheduled.push(job);
				}
			}
			await Promise.all(scheduled.map((job) => job.completion));
			signal?.throwIfAborted();
		} finally {
			signal?.removeEventListener("abort", abort);
		}
		return this.status(project);
	}
	async search(project: Project, query: string, limit = 6, signal?: AbortSignal): Promise<KnowledgeHit[]> {
		return (await this.retrieve(project, query, limit, signal)).hits;
	}
	async retrieve(
		project: Project,
		query: string,
		limit = 6,
		signal?: AbortSignal,
		options: KnowledgeSearchOptions = {},
	): Promise<KnowledgeSearchResult> {
		const started = performance.now();
		const combined = signal ? AbortSignal.any([signal, this.shutdown.signal]) : this.shutdown.signal;
		combined.throwIfAborted();
		if (query.length > 12000) throw new WorkbenchError("invalid_input", "检索问题超过 12000 字符，请缩短问题");
		const settings = await this.settings(project);
		const empty: KnowledgeSearchResult = {
			queries: query.trim() ? [query] : [],
			hits: [],
			context: "",
			contextTokens: 0,
			mqe: { mode: settings.mqe, applied: false, reason: "没有可用索引或问题为空" },
			hyde: { mode: settings.hyde ?? "off", applied: false, reason: "没有可用文本索引或问题为空" },
			diagnostics: [],
			elapsedMs: 0,
		};
		if (!query.trim()) return empty;
		const files = await this.repository.listFiles(project.id);
		if (!files.length)
			return { ...empty, diagnostics: ["当前项目没有可检索索引"], elapsedMs: performance.now() - started };
		let index: IndexConfiguration | undefined;
		const configurationDiagnostics: string[] = [];
		try {
			index = await this.configuration(project);
		} catch (error) {
			configurationDiagnostics.push(error instanceof WorkbenchError ? error.message : "知识库 tokenizer 配置不可用");
		}
		if (index && !files.some((file) => file.indexFingerprint === index!.fingerprint)) {
			configurationDiagnostics.push("文本索引已过期，请重新建立索引；本次不检索旧解析／分块／模型指纹的片段。");
		}
		const tokenizer = index?.tokenizer ?? encodingTokenizer("cl100k_base");
		const generator =
			options.generate ??
			(this.options.generateQueries
				? (prompt: string, signal: AbortSignal) => this.options.generateQueries!(prompt, signal, options.model)
				: undefined);
		const expansion = index
			? await expandQueries(query, settings, options.context ?? [], generator, combined)
			: {
					queries: [query],
					diagnostics: [],
					mqe: { mode: settings.mqe, applied: false, reason: "向量能力缺失，本次仅使用原问题" },
				};
		const { queries, diagnostics } = expansion;
		const hasCurrentIndex = Boolean(index && files.some((file) => file.indexFingerprint === index!.fingerprint));
		const hypothesis = await generateHyde(
			query,
			{ ...settings, hyde: hasCurrentIndex ? settings.hyde : "off" },
			options.context ?? [],
			options.generateHypothesis ??
				(this.options.generateHypothesis
					? (prompt, signal) => this.options.generateHypothesis!(prompt, signal, options.model)
					: undefined),
			combined,
		);
		if (!hasCurrentIndex)
			hypothesis.hyde = {
				mode: settings.hyde ?? "off",
				applied: false,
				reason: "没有当前有效的文本向量索引，未运行 HyDE",
			};
		hypothesis.hyde.model = options.model;
		diagnostics.push(...hypothesis.diagnostics);
		let hydeInput: string | undefined;
		if (hypothesis.hyde.document) {
			try {
				const tokens = await withKnowledgeTokenizer(
					tokenizer,
					() => tokenizer.count(hypothesis.hyde.document!),
					AbortSignal.any([combined, AbortSignal.timeout(5000)]),
				);
				hypothesis.hyde.tokenCount = tokens;
				if (tokens <= Math.min(settings.hydeTokens ?? 256, settings.queryTokens))
					hydeInput = hypothesis.hyde.document;
				else {
					hypothesis.hyde.reason = "假设文档超过 HyDE／查询 Token 上限，未截断条件，保留常规检索";
					diagnostics.push(hypothesis.hyde.reason);
				}
			} catch {
				combined.throwIfAborted();
				hypothesis.hyde.reason = "HyDE Token 计量失败，保留常规检索";
				diagnostics.push(hypothesis.hyde.reason);
			}
		}
		diagnostics.push(...configurationDiagnostics);
		if (!index) diagnostics.push("使用关键词检索；上下文预算由本地编码器计数，未用其生成供应商向量。");
		if (index && files.some((file) => file.indexFingerprint !== index!.fingerprint))
			diagnostics.push("部分文件索引已过期，本次仅检索当前指纹的片段");
		const ranked: Array<{ query: string; method: "keyword" | "vector" | "hyde"; hits: KnowledgeHit[] }> = [];
		const inputs = index
			? tokenizer.resolve
				? [...queries]
				: queries.filter((input) => tokenizer.count(input) <= settings.queryTokens)
			: [];
		if (index && inputs.length !== queries.length)
			diagnostics.push("部分查询超过查询 Token 上限，保留完整原查询用于关键词检索，未截断实体或条件");
		const hydePosition = hydeInput ? inputs.length : -1;
		if (hydeInput) inputs.push(hydeInput);
		const vectorSignal = AbortSignal.any([combined, AbortSignal.timeout(5000)]);
		const vectorsPromise = (async () => {
			if (!inputs.length || !index) return [];
			let vectors: number[][];
			try {
				vectors = options.embeddingScope
					? await options.embeddingScope.batch(index.embedding, inputs, vectorSignal)
					: await this.embeddings.embed(index.embedding, inputs, vectorSignal);
			} catch (error) {
				combined.throwIfAborted();
				if (!hydeInput || vectorSignal.aborted) throw error;
				inputs.splice(hydePosition, 1);
				diagnostics.push("含 HyDE 的批量嵌入失败，已单独重试原问题与 MQE 查询");
				vectors = await this.embeddings.embed(index.embedding, inputs, vectorSignal);
			}
			if (tokenizer.resolve) {
				const valid = await withKnowledgeTokenizer(
					tokenizer,
					() => inputs.map((input) => tokenizer.count(input) <= settings.queryTokens),
					vectorSignal,
				);
				if (valid.some((value) => !value))
					diagnostics.push("部分查询超过查询 Token 上限，保留完整原查询用于关键词检索，未截断实体或条件");
				return vectors.map((vector, position) => (valid[position] ? vector : []));
			}
			return vectors;
		})();
		// Observe both branches, including failures, before cancellation or fallback returns.
		const keywordPromise = Promise.all(
			queries.map(async (input) => ({
				query: input,
				method: "keyword" as const,
				hits: await this.repository.searchKeywords(
					project.id,
					index?.fingerprint ?? keywordIndexFingerprint(settings),
					input,
					30,
				),
			})),
		);
		const nativePromise = (async () => {
			const hasImages = (await this.repository.listDocuments(project.id)).some(
				(value) =>
					value.status === "ready" &&
					(value.mimeType.startsWith("image/") || value.mimeType === "application/pdf"),
			);
			if (!hasImages) return [];
			const endpoint = await this.perception.configuration.endpoint("multimodal");
			if (query.length > 600)
				throw new WorkbenchError("invalid_input", "图文查询超过首版 600 字符上限，保留完整问题供关键词检索");
			const vector = await this.perception.embed({ text: query }, endpoint, vectorSignal);
			return this.repository.searchPerceptualVectors(project.id, endpoint.spaceId, vector, 30);
		})();
		const [vectors, keywords, native] = await Promise.allSettled([vectorsPromise, keywordPromise, nativePromise]);
		combined.throwIfAborted();
		if (keywords.status === "fulfilled") ranked.push(...keywords.value);
		else diagnostics.push("关键词检索失败，本次使用向量结果");
		if (native.status === "fulfilled" && native.value.length)
			ranked.push({ query, method: "vector", hits: native.value.filter((hit) => hit.score > 0) });
		else if (native.status === "rejected")
			diagnostics.push(
				native.reason instanceof WorkbenchError ? native.reason.message : "图文向量查询超时或失败，保留文字结果",
			);
		if (vectors.status === "fulfilled" && index) {
			for (const [position, vector] of vectors.value.entries()) {
				combined.throwIfAborted();
				if (!vector.length) continue;
				try {
					const recalled = (
						await this.repository.search(project.id, index.embedding.fingerprint, vector, 30, index.fingerprint)
					).filter((hit) => hit.score > 0);
					if (position === hydePosition) {
						hypothesis.hyde.applied = true;
						hypothesis.hyde.reason = recalled.length
							? "假设文档已用于向量召回与 RRF 融合；它不是证据"
							: "HyDE 向量未命中真实片段，保留常规结果";
					}
					ranked.push({
						query: position === hydePosition ? query : inputs[position],
						method: position === hydePosition ? "hyde" : "vector",
						hits: recalled,
					});
				} catch (error) {
					diagnostics.push(error instanceof WorkbenchError ? error.message : "向量检索失败，本次使用关键词结果");
				}
			}
		} else if (vectors.status === "rejected")
			diagnostics.push(
				vectors.reason instanceof WorkbenchError
					? `${vectors.reason.message}；已降级为关键词检索`
					: "向量嵌入失败，已降级为关键词检索",
			);
		if (hydeInput && !hypothesis.hyde.applied) {
			hypothesis.hyde.reason = "HyDE 向量召回未成功，保留常规检索";
			diagnostics.push(hypothesis.hyde.reason);
		}
		const hits = fuseKnowledge(ranked);
		const documents = await this.repository.listDocuments(project.id);
		const enriched = await Promise.all(
			hits.map(async (hit) => {
				const document = documents.find((entry) => entry.path === hit.path && !entry.supersededBy);
				const review = document?.descriptionReview
					? descriptionReview(document, await this.repository.getDerived(project.id, document.path))
					: undefined;
				return document
					? {
							...hit,
							sources: reviewedSources(hit.sources, review?.reviewedAt),
							path: document.name,
							name: document.name,
							documentId: document.id,
							sourcePath: await this.documentFile(project, document),
						}
					: { ...hit, sourcePath: join(project.sourcePath ?? project.workspacePath, hit.path) };
			}),
		);
		combined.throwIfAborted();
		let selected: ReturnType<typeof selectKnowledgeContext>;
		try {
			selected = await withKnowledgeTokenizer(
				tokenizer,
				() => selectKnowledgeContext(enriched, tokenizer, settings.contextTokens, Math.max(1, Math.min(20, limit))),
				AbortSignal.any([combined, AbortSignal.timeout(30000)]),
			);
		} catch (error) {
			combined.throwIfAborted();
			if (!tokenizer.resolve) throw error;
			diagnostics.push("供应商上下文 Token 计量失败，未注入未经预算验证的片段；请稍后重试");
			selected = { hits: [], context: "", contextTokens: 0, skipped: 0 };
		}
		if (selected.skipped) diagnostics.push(`最终上下文 Token 预算不足，跳过 ${selected.skipped} 个完整片段`);
		return {
			...expansion,
			hyde: hypothesis.hyde,
			hits: selected.hits,
			context: selected.context,
			contextTokens: selected.contextTokens,
			tokenizer: tokenizer.name,
			diagnostics: [...new Set(diagnostics)],
			elapsedMs: performance.now() - started,
		};
	}
}
