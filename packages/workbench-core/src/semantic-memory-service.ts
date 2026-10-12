import { readFile } from "node:fs/promises";
import { WorkbenchError } from "./errors.ts";
import { redactLearningText } from "./learning.ts";
import type { MemoryConfirmation, MemoryEvidence } from "./memory-layers.ts";
import type { MemoryScope, MemoryService, ProposeMemoryInput } from "./memory-service.ts";
import type { MemoryKind, MemorySearchResult } from "./models.ts";
import { memoryHash, replaceSemanticBlocks, semanticBlocks, semanticMarkdown } from "./semantic-markdown.ts";
import type { SemanticChange, SemanticEmbeddingPort, SemanticMemory, SemanticRepository } from "./semantic-memory.ts";
import { defaultSystemServices, type SystemServices } from "./system.ts";
import { type PathPolicy, type WorkbenchPaths, writeTextAtomically } from "./workspace.ts";

export class SemanticMemoryService {
	private readonly paths: WorkbenchPaths;
	private readonly policy: PathPolicy;
	private readonly repository: SemanticRepository;
	private readonly memory: Pick<MemoryService, "propose" | "accept" | "edit">;
	private readonly embedding?: SemanticEmbeddingPort;
	private readonly system: SystemServices;
	constructor(options: {
		paths: WorkbenchPaths;
		policy: PathPolicy;
		repository: SemanticRepository;
		memory: Pick<MemoryService, "propose" | "accept" | "edit">;
		embedding?: SemanticEmbeddingPort;
		system?: SystemServices;
	}) {
		this.paths = options.paths;
		this.policy = options.policy;
		this.repository = options.repository;
		this.memory = options.memory;
		this.embedding = options.embedding;
		this.system = options.system ?? defaultSystemServices;
	}
	async prepare(
		content: string,
		kind: Exclude<MemoryKind, "daily">,
		path: string,
		projectId: string | undefined,
		input: ProposeMemoryInput,
		id: string,
		confirmation: MemoryConfirmation = "user_confirmed",
	): Promise<{ preview: string; change: SemanticChange; proposedText: string }> {
		if (
			input.proposedText.includes("<!-- workbench-semantic") ||
			redactLearningText(input.proposedText) !== input.proposedText
		)
			throw new WorkbenchError("invalid_input", "候选包含凭证或保留的记忆锚点");
		const blocks = semanticBlocks(content, kind, path, projectId);
		const records = await Promise.all(
			blocks.map(async (block) => {
				const indexed = await this.repository.getSemantic(block.record.id);
				return indexed && indexed.version >= block.record.version ? indexed : block.record;
			}),
		);
		const now = this.system.now().toISOString();
		const similar = records.filter(
			(record) => record.status === "active" && similarity(record.text, input.proposedText) >= 0.72,
		);
		const duplicate = similar.find((record) => normalize(record.text) === normalize(input.proposedText));
		const versionChange = similar.find(
			(record) =>
				record.text !== input.proposedText &&
				/\d/.test(record.text) &&
				normalize(record.text.replace(/\d+(?:\.\d+)*/g, "VERSION")) ===
					normalize(input.proposedText.replace(/\d+(?:\.\d+)*/g, "VERSION")),
		);
		const change: SemanticChange = {
			...input.semanticChange,
			operation: input.semanticChange?.operation ?? (duplicate ? "merge" : versionChange ? "supersede" : "create"),
			targetId: input.semanticChange?.targetId ?? duplicate?.id ?? versionChange?.id,
			duplicateIds: duplicate ? [duplicate.id] : [],
			conflictIds: versionChange
				? [versionChange.id]
				: similar.filter((record) => record !== duplicate).map((record) => record.id),
		};
		for (const value of [change.validFrom, change.validUntil])
			if (value !== undefined && (!Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value))
				throw new WorkbenchError("invalid_input", "生效与失效时间必须使用 UTC ISO 时间");
		if (change.validUntil && change.validUntil <= (change.validFrom ?? now))
			throw new WorkbenchError("invalid_input", "失效时间必须晚于生效时间");
		const target = records.find((record) => record.id === change.targetId);
		if (change.operation !== "create" && !target) throw new WorkbenchError("not_found", "更新目标不在当前记忆文件中");
		if (
			input.semanticChange?.expectedVersion !== undefined &&
			target?.version !== input.semanticChange.expectedVersion
		)
			throw new WorkbenchError("conflict", "语义记忆版本已变化");
		change.expectedVersion = target?.version;
		const evidence: MemoryEvidence[] =
			change.evidence ??
			input.evidence ??
			(input.sessionId
				? [
						{
							kind: input.toolCallId ? "tool" : "message",
							id: input.toolCallId ?? input.runId ?? input.sessionId,
							sessionId: input.sessionId,
							runId: input.runId,
							toolCallId: input.toolCallId,
							confirmation: "unverified",
							availability: "present",
						},
					]
				: []);
		const updates: SemanticMemory[] = [];
		const record: SemanticMemory = {
			id: change.operation === "create" || change.operation === "supersede" ? id : target!.id,
			kind,
			projectId,
			relativePath: path,
			text: input.proposedText.trim(),
			heading: input.heading ?? target?.heading,
			version: change.operation === "create" || change.operation === "supersede" ? 1 : target!.version + 1,
			origin: input.sessionId ? "model" : "user",
			confirmation,
			evidence: [...(target?.evidence ?? []), ...evidence].slice(-20),
			validFrom: change.validFrom ?? now,
			validUntil: change.validUntil,
			status: "active",
			conflict: change.operation === "create" && change.conflictIds?.length ? "detected" : "none",
			contentHash: memoryHash(input.proposedText.trim()),
			updatedAt: now,
			startLine: target?.startLine ?? content.split(/\r?\n/).length + 1,
			endLine: target?.endLine ?? 0,
		};
		if (change.operation === "invalidate") {
			record.text = target!.text;
			record.status = "invalidated";
			record.validUntil = now;
		}
		if (change.operation === "rollback") {
			const historical = (await this.repository.semanticHistory(target!.id)).find(
				(value) => value.version === change.rollbackVersion,
			);
			if (!historical) throw new WorkbenchError("not_found", "历史版本不存在");
			record.text = historical.text;
			record.status = historical.status;
			record.confirmation = historical.confirmation;
			record.evidence = historical.evidence;
			record.conflict = historical.conflict;
			record.validUntil = undefined;
			if (target?.supersededBy) {
				const current = records.find((value) => value.id === target.supersededBy);
				if (current)
					updates.push({
						...current,
						status: "invalidated",
						validUntil: now,
						version: current.version + 1,
						updatedAt: now,
					});
				record.status = "active";
				record.supersededBy = undefined;
			}
		}
		if (change.operation === "supersede") {
			record.supersedes = target!.id;
			updates.push({
				...target!,
				status: "superseded",
				supersededBy: record.id,
				validUntil: now,
				updatedAt: now,
				version: target!.version + 1,
			});
		}
		for (const mergeId of change.mergeIds ?? []) {
			const other = records.find((value) => value.id === mergeId);
			if (!other || other.id === record.id) throw new WorkbenchError("invalid_input", "合并条目不在当前范围");
			updates.push({
				...other,
				status: "superseded",
				supersededBy: record.id,
				validUntil: now,
				version: other.version + 1,
				updatedAt: now,
			});
		}
		record.contentHash = memoryHash(record.text);
		updates.push(record);
		return {
			proposedText: record.text,
			preview: replaceSemanticBlocks(content, blocks, [
				...records.filter((existing) => !updates.some((update) => update.id === existing.id)),
				...updates,
			]),
			change,
		};
	}
	async synchronize(
		kind: MemoryKind,
		path: string,
		content: string,
		projectId?: string,
		trusted = false,
	): Promise<void> {
		if (kind === "daily") return;
		const values = semanticBlocks(content, kind, path, projectId).map((block) => block.record);
		for (const value of values) {
			const old = await this.repository.getSemantic(value.id);
			if (old && (old.relativePath !== path || old.projectId !== projectId))
				throw new WorkbenchError("conflict", "语义记忆 ID 已属于另一个文件或项目");
		}
		for (const value of values) {
			const old = await this.repository.getSemantic(value.id);
			const observed = semanticSourceHash(value);
			if (old && !trusted && (old.externalHash ?? semanticSourceHash(old)) !== observed) {
				value.version = Math.max(value.version, old.version + 1);
				value.confirmation = "unknown";
				value.conflict = "external_edit";
				value.updatedAt = this.system.now().toISOString();
			} else if (old && !trusted) {
				value.version = old.version;
				value.confirmation = old.confirmation;
				value.conflict = old.conflict;
				value.updatedAt = old.updatedAt;
			}
			value.externalHash = observed;
			if (old && value.version > old.version) await this.archive(old);
			await this.archive(value);
		}
		await this.repository.replaceSemantics(path, values);
	}
	async list(scope: MemoryScope, history = false): Promise<SemanticMemory[]> {
		return this.repository.listSemantics({
			projectId: scope.project?.id,
			at: this.system.now().toISOString(),
			activeOnly: !history,
		});
	}
	async history(id: string, scope: MemoryScope): Promise<SemanticMemory[]> {
		const versions = await this.repository.semanticHistory(id);
		const record = (await this.repository.getSemantic(id)) ?? versions.at(-1);
		if (!record || (record.projectId && record.projectId !== scope.project?.id))
			throw new WorkbenchError("not_found", "条目不在当前范围");
		return versions;
	}
	async change(scope: MemoryScope, input: ProposeMemoryInput): Promise<SemanticMemory[]> {
		const candidate = await this.memory.propose(scope, input);
		const applied = await this.memory.accept(candidate.id);
		if (applied.status !== "accepted") throw new WorkbenchError("conflict", "记忆文件已变化");
		return this.list(scope, true);
	}
	async search(
		scope: MemoryScope,
		query: string,
		limit: number,
		signal?: AbortSignal,
		embedding: SemanticEmbeddingPort | undefined = this.embedding,
	): Promise<MemorySearchResult[]> {
		const request = {
			projectId: scope.project?.id,
			at: this.system.now().toISOString(),
			query,
			limit: Math.min(50, limit * 2),
		};
		const keyword = await this.repository.listSemantics(request);
		let vectors: SemanticMemory[] = [];
		if (embedding && (await embedding.fingerprint())) {
			try {
				const value = await embedding.embed(
					query,
					signal ? AbortSignal.any([signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000),
				);
				vectors = await this.repository.searchSemanticVectors(request, value.fingerprint, value.vector);
			} catch {
				signal?.throwIfAborted();
			}
		}
		const ranked = new Map<string, { record: SemanticMemory; score: number }>();
		for (const values of [keyword, vectors])
			for (const [rank, record] of values.entries()) {
				const score = 1 / (60 + rank) + (record.confirmation === "user_confirmed" ? 0.001 : 0);
				ranked.set(record.id, { record, score: (ranked.get(record.id)?.score ?? 0) + score });
			}
		return [...ranked.values()]
			.sort((a, b) => b.score - a.score)
			.slice(0, limit)
			.map(({ record, score }) => ({
				memoryId: record.id,
				kind: record.kind,
				projectId: record.projectId,
				relativePath: record.relativePath,
				startLine: record.startLine,
				endLine: record.endLine,
				heading: record.heading,
				snippet: `[${record.confirmation}; v${record.version}; ${record.conflict}] ${record.text}`,
				contentHash: record.contentHash,
				score: 150 + score,
			}));
	}
	async rebuildVectors(scope: MemoryScope, signal?: AbortSignal): Promise<number> {
		if (!this.embedding || !(await this.embedding.fingerprint()))
			throw new WorkbenchError("conflict", "未配置文本 Embedding，关键词检索仍可使用");
		const records = await this.repository.listSemantics({
			projectId: scope.project?.id,
			at: this.system.now().toISOString(),
			limit: 10000,
		});
		for (const record of records) {
			signal?.throwIfAborted();
			const value = await this.embedding.embed(record.text, signal);
			await this.repository.saveSemanticVector(record.id, record.version, value.fingerprint, value.vector);
		}
		return records.length;
	}
	private async archive(record: SemanticMemory): Promise<void> {
		const path = await this.policy.requireWorkspace(`memory/history/${record.id}/${record.version}.md`);
		const existing = await readFile(path.absolutePath, "utf8").catch((error: unknown) => {
			if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
				return undefined;
			throw error;
		});
		if (!existing) await writeTextAtomically(path.absolutePath, `${semanticMarkdown(record)}\n`);
	}
}
function semanticSourceHash(value: SemanticMemory): string {
	return memoryHash(
		JSON.stringify([
			value.id,
			value.text,
			value.version,
			value.status,
			value.confirmation,
			value.origin,
			value.evidence,
			value.validFrom,
			value.validUntil,
			value.supersedes,
			value.supersededBy,
			value.conflict,
			value.heading,
			value.updatedAt,
		]),
	);
}
function normalize(text: string): string {
	return text.toLocaleLowerCase().replace(/[\s\p{P}]/gu, "");
}
function similarity(a: string, b: string): number {
	const aa = normalize(a);
	const bb = normalize(b);
	const terms = (text: string) =>
		new Set(Array.from({ length: Math.max(0, text.length - 1) }, (_, index) => text.slice(index, index + 2)));
	const left = terms(aa);
	const right = terms(bb);
	return left.size + right.size
		? (2 * [...left].filter((term) => right.has(term)).length) / (left.size + right.size)
		: 0;
}
