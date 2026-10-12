import { createHash } from "node:crypto";
import { readFile, stat, unlink } from "node:fs/promises";
import { EOL } from "node:os";
import { relative } from "node:path";
import { WorkbenchError } from "./errors.ts";
import type {
	MemoryCandidate,
	MemoryFileRecord,
	MemoryIndexEntry,
	MemoryKind,
	MemorySearchResult,
	Project,
} from "./models.ts";
import type { MemoryRepository } from "./repositories.ts";
import { withoutProjectContext, withoutSemanticBlocks } from "./semantic-markdown.ts";
import type { SemanticChange, SemanticEmbeddingPort, SemanticRepository } from "./semantic-memory.ts";
import type { SemanticMemoryService } from "./semantic-memory-service.ts";
import { defaultSystemServices, type SystemServices, toTimestamp } from "./system.ts";
import { type PathPolicy, type WorkbenchPaths, writeTextAtomically } from "./workspace.ts";

export interface MemoryScope {
	project?: Pick<Project, "id" | "slug">;
}

export interface MemoryDocument {
	path: string;
	content: string;
	contentHash: string;
	size: number;
	modifiedAt: string;
}

type MemoryPathPolicy = Pick<PathPolicy, "requireMemory" | "requireWorkspace" | "isProtectedMemoryPath">;

export interface ProposeMemoryInput {
	evidence?: SemanticChange["evidence"];
	semanticChange?: SemanticChange;
	kind: MemoryKind;
	proposedText: string;
	reason: string;
	heading?: string;
	date?: string;
	sessionId?: string;
	runId?: string;
	toolCallId?: string;
	idempotencyKey?: string;
}

function hash(content: string): string {
	return createHash("sha256").update(content).digest("hex");
}

function datePath(date: string): string {
	if (!/^\d{4}-\d{2}-\d{2}$/u.test(date))
		throw new WorkbenchError("invalid_input", "Daily memory date must be YYYY-MM-DD");
	return `memory/${date}.md`;
}

function memoryTarget(paths: WorkbenchPaths, scope: MemoryScope, kind: MemoryKind, date: string): string {
	switch (kind) {
		case "user":
			return "USER.md";
		case "global":
			return "MEMORY.md";
		case "daily":
			return datePath(date);
		case "project":
			if (!scope.project) throw new WorkbenchError("invalid_input", "Project memory requires a bound project");
			return relative(paths.workspace, paths.project(scope.project.slug).memoryFile).replaceAll("\\", "/");
	}
}

function appendCandidate(content: string, candidate: MemoryCandidate): string {
	const current = content.trimEnd();
	const heading = candidate.heading?.trim();
	const addition = heading
		? `## ${heading}${EOL}${EOL}${candidate.proposedText.trim()}`
		: candidate.proposedText.trim();
	return `${current}${current ? `${EOL}${EOL}` : ""}${addition}${EOL}`;
}

interface IndexedMemory {
	file: MemoryFileRecord;
	entries: MemoryIndexEntry[];
}

const SEARCH_STOP_WORDS = new Set([
	"about",
	"continue",
	"from",
	"have",
	"please",
	"project",
	"that",
	"this",
	"what",
	"with",
]);

function retrievalQueries(query: string): string[] {
	const queries = new Set<string>([query]);
	for (const word of query.toLocaleLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}_-]{2,}/gu) ?? []) {
		if (!SEARCH_STOP_WORDS.has(word)) queries.add(word);
	}
	for (const phrase of query.match(/[\p{Script=Han}]{2,}/gu) ?? []) {
		for (let index = 0; index < phrase.length - 1; index += 1) queries.add(phrase.slice(index, index + 2));
	}
	const values = [...queries];
	// Spread the bounded keyword probes across the question, rather than losing its final subject.
	return values.length <= 48
		? values
		: Array.from({ length: 48 }, (_, index) => values[Math.round((index * (values.length - 1)) / 47)]);
}

export class MemoryService {
	private readonly paths: WorkbenchPaths;
	private readonly pathPolicy: MemoryPathPolicy;
	private readonly repository: MemoryRepository;
	private readonly system: SystemServices;
	private readonly durability?: SemanticRepository;
	private semantic?: SemanticMemoryService;
	private readonly writes = new Set<string>();

	constructor(
		paths: WorkbenchPaths,
		pathPolicy: MemoryPathPolicy,
		repository: MemoryRepository,
		system: SystemServices = defaultSystemServices,
		durability?: SemanticRepository,
	) {
		this.paths = paths;
		this.pathPolicy = pathPolicy;
		this.repository = repository;
		this.system = system;
		this.durability = durability;
	}

	attachSemantics(service: SemanticMemoryService): void {
		this.semantic = service;
	}

	async propose(scope: MemoryScope, input: ProposeMemoryInput): Promise<MemoryCandidate> {
		const proposedText = input.proposedText.trim();
		const reason = input.reason.trim();
		if (!proposedText || !reason)
			throw new WorkbenchError("invalid_input", "Memory proposal text and reason are required");
		if (input.idempotencyKey) {
			const existing = await this.repository.getCandidateByIdempotencyKey(input.idempotencyKey);
			if (existing) return existing;
		}
		const nowDate = this.system.now();
		const relativePath = memoryTarget(this.paths, scope, input.kind, input.date ?? toTimestamp(nowDate).slice(0, 10));
		const classified = await this.pathPolicy.requireMemory(relativePath);
		const content = await readFile(classified.absolutePath, "utf8").catch((error: unknown) => {
			if (input.kind === "daily") return `# Daily Memory ${relativePath.slice(7, 17)}${EOL}`;
			throw error;
		});
		const now = toTimestamp(nowDate);
		const id = this.system.id();
		if (input.kind !== "daily")
			await this.semantic?.synchronize(
				input.kind,
				relativePath,
				content,
				input.kind === "project" ? scope.project?.id : undefined,
			);
		const structured =
			input.kind !== "daily"
				? await this.semantic?.prepare(
						content,
						input.kind,
						relativePath,
						input.kind === "project" ? scope.project?.id : undefined,
						input,
						id,
					)
				: undefined;
		const candidate: MemoryCandidate = {
			id,
			semanticChange: structured?.change,
			kind: input.kind,
			projectId: input.kind === "project" ? scope.project?.id : undefined,
			relativePath,
			heading: input.heading?.trim() || undefined,
			proposedText: structured?.proposedText ?? proposedText,
			reason,
			preview:
				structured?.preview ??
				appendCandidate(content, {
					id: "preview",
					kind: input.kind,
					relativePath,
					proposedText,
					reason,
					preview: "",
					baseHash: "",
					status: "pending",
					heading: input.heading?.trim() || undefined,
					createdAt: now,
					updatedAt: now,
				}),
			baseHash: hash(content),
			status: "pending",
			sessionId: input.sessionId,
			runId: input.runId,
			toolCallId: input.toolCallId,
			idempotencyKey: input.idempotencyKey,
			createdAt: now,
			updatedAt: now,
		};
		return this.repository.createCandidate(candidate);
	}

	async accept(id: string): Promise<MemoryCandidate> {
		const candidate = await this.getCandidate(id);
		if (candidate.status === "accepted") return candidate;
		if (candidate.status !== "pending")
			throw new WorkbenchError("conflict", `Memory candidate is ${candidate.status}`);
		const classified = await this.pathPolicy.requireMemory(candidate.relativePath);
		let content: string;
		try {
			content = await readFile(classified.absolutePath, "utf8");
		} catch (error) {
			if (candidate.kind !== "daily") throw error;
			content = `# Daily Memory ${candidate.relativePath.slice(7, 17)}${EOL}`;
		}
		if (hash(content) !== candidate.baseHash) {
			return this.resolveCandidate(candidate, "conflicted");
		}
		const updatedContent = candidate.semanticChange ? candidate.preview : appendCandidate(content, candidate);
		await this.commitWrite(
			candidate.kind,
			candidate.relativePath,
			candidate.projectId,
			updatedContent,
			candidate.id,
			candidate.kind === "daily" && !(await stat(classified.absolutePath).catch(() => undefined))
				? null
				: candidate.baseHash,
		);
		const appliedHash = hash(updatedContent);
		const applied: MemoryCandidate = {
			...candidate,
			appliedHash,
			updatedAt: toTimestamp(this.system.now()),
		};
		await this.repository.updateCandidate(applied);
		const indexed = await this.buildIndex(
			candidate.kind,
			candidate.projectId,
			candidate.relativePath,
			updatedContent,
		);
		const accepted: MemoryCandidate = {
			...applied,
			status: "accepted",
			updatedAt: toTimestamp(this.system.now()),
			resolvedAt: toTimestamp(this.system.now()),
		};
		await this.repository.completeCandidate(accepted, indexed.file, indexed.entries);
		return accepted;
	}

	async reject(id: string): Promise<MemoryCandidate> {
		const candidate = await this.getCandidate(id);
		if (candidate.status === "rejected") return candidate;
		if (candidate.status !== "pending")
			throw new WorkbenchError("conflict", `Memory candidate is ${candidate.status}`);
		return this.resolveCandidate(candidate, "rejected");
	}

	async getCandidate(id: string): Promise<MemoryCandidate> {
		const candidate = await this.repository.getCandidate(id);
		if (!candidate) throw new WorkbenchError("not_found", `Memory candidate not found: ${id}`);
		return candidate;
	}

	listCandidates(status?: MemoryCandidate["status"]): Promise<MemoryCandidate[]> {
		return this.repository.listCandidates(status);
	}

	listFiles(): Promise<MemoryFileRecord[]> {
		return this.repository.listFiles();
	}

	async read(relativePath: string): Promise<MemoryDocument> {
		const file = (await this.repository.listFiles()).find((value) => value.relativePath === relativePath);
		if (!file) throw new WorkbenchError("not_found", "记忆文件不存在");
		const target = await this.pathPolicy.requireMemory(file.relativePath);
		if (!this.pathPolicy.isProtectedMemoryPath(target.absolutePath))
			throw new WorkbenchError("path_denied", "只能通过记忆入口读取长期记忆");
		const metadata = await stat(target.realPath);
		if (!metadata.isFile() || metadata.size > 2 * 1024 * 1024)
			throw new WorkbenchError("invalid_input", "记忆预览只支持最多 2 MiB 的文本文件");
		const content = await readFile(target.realPath, "utf8");
		if (content.includes("\0")) throw new WorkbenchError("invalid_input", "记忆文件不是文本");
		return {
			path: file.relativePath,
			content,
			contentHash: hash(content),
			size: metadata.size,
			modifiedAt: metadata.mtime.toISOString(),
		};
	}
	/** Standing prose stays available without keyword overlap. Code examples require recall. */
	async standingEntries(scope: MemoryScope, kind: Exclude<MemoryKind, "daily">): Promise<MemorySearchResult[]> {
		if (kind === "project" && !scope.project) return [];
		const relativePath = memoryTarget(this.paths, scope, kind, "");
		const path = await this.pathPolicy.requireMemory(relativePath);
		const content = await readFile(path.realPath, "utf8");
		const projectId = kind === "project" ? scope.project?.id : undefined;
		const indexed = await this.buildIndex(kind, projectId, relativePath, content);
		return indexed.entries
			.filter((entry) => !/```|~~~|<!doctype\b|<(?:html|svg|div|script)\b/iu.test(entry.content))
			.map((entry) => ({
				memoryId: entry.id,
				projectId,
				kind,
				relativePath,
				startLine: entry.startLine,
				endLine: entry.endLine,
				heading: entry.heading,
				snippet: entry.content,
				contentHash: entry.contentHash,
				score: 1,
			}));
	}

	async delete(kind: MemoryKind, relativePath: string, projectId?: string): Promise<void> {
		if (kind !== "daily") {
			throw new WorkbenchError(
				"invalid_input",
				"User, global, and project memory files must be edited instead of deleted",
			);
		}
		const classified = await this.pathPolicy.requireMemory(relativePath);
		if (!this.pathPolicy.isProtectedMemoryPath(classified.absolutePath)) {
			throw new WorkbenchError("invalid_input", "The selected file is not a managed memory file");
		}
		await this.commitWrite(kind, relativePath, projectId, null);
	}

	async reindex(
		kind: MemoryKind,
		relativePath: string,
		projectId?: string,
		trusted = false,
	): Promise<MemoryFileRecord> {
		const classified = await this.pathPolicy.requireMemory(relativePath);
		const content = await readFile(classified.absolutePath, "utf8");
		try {
			await this.semantic?.synchronize(kind, relativePath, content, projectId, trusted);
		} catch (error) {
			await this.repository.deleteFile(kind, projectId, relativePath);
			await this.durability?.replaceSemantics(relativePath, []);
			throw error;
		}
		const indexed = await this.buildIndex(kind, projectId, relativePath, content);
		await this.repository.replaceFileIndex(indexed.file, indexed.entries);
		return indexed.file;
	}

	async refreshIndex(scope: MemoryScope, signal?: AbortSignal): Promise<void> {
		for (const file of await this.repository.listFiles()) {
			signal?.throwIfAborted();
			if (file.kind === "project" && file.projectId !== scope.project?.id) continue;
			const target = await this.pathPolicy.requireMemory(file.relativePath);
			const metadata = await stat(target.absolutePath).catch((error: unknown) => {
				if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
					return undefined;
				throw error;
			});
			if (!metadata) {
				await this.repository.deleteFile(file.kind, file.projectId, file.relativePath);
				await this.durability?.replaceSemantics(file.relativePath, []);
			} else if (metadata.size !== file.size || metadata.mtime.toISOString() !== file.modifiedAt)
				await this.reindex(file.kind, file.relativePath, file.projectId);
		}
	}
	async search(
		scope: MemoryScope,
		query: string,
		limit = 10,
		options: { signal?: AbortSignal; embedding?: SemanticEmbeddingPort } = {},
	): Promise<MemorySearchResult[]> {
		const trimmed = query.trim();
		if (!trimmed) throw new WorkbenchError("invalid_input", "Memory search query is required");
		const boundedLimit = Math.max(1, Math.min(50, Math.trunc(limit)));
		const kinds: MemoryKind[] = scope.project ? ["project", "user", "global", "daily"] : ["user", "global", "daily"];
		const merged = new Map<string, MemorySearchResult>();
		await this.refreshIndex(scope, options.signal);
		for (const candidate of retrievalQueries(trimmed)) {
			const results = await this.repository.search(candidate, {
				projectId: scope.project?.id,
				kinds,
				limit: boundedLimit,
			});
			for (const result of results) {
				const weighted = {
					...result,
					score: result.score + (candidate === trimmed ? 100 : Math.min(candidate.length, 20)),
				};
				const current = merged.get(result.memoryId);
				if (!current || weighted.score > current.score) merged.set(result.memoryId, weighted);
			}
		}
		for (const result of (await this.semantic?.search(
			scope,
			trimmed,
			boundedLimit,
			options.signal,
			options.embedding,
		)) ?? [])
			merged.set(result.memoryId, result);
		return [...merged.values()].sort((left, right) => right.score - left.score).slice(0, boundedLimit);
	}

	async edit(
		relativePath: string,
		content: string,
		expectedHash: string,
		kind: MemoryKind,
		projectId?: string,
	): Promise<MemoryFileRecord> {
		const classified = await this.pathPolicy.requireMemory(relativePath);
		if (!this.pathPolicy.isProtectedMemoryPath(classified.absolutePath)) {
			throw new WorkbenchError("invalid_input", "The selected file is not a managed memory file");
		}
		const current = await readFile(classified.absolutePath, "utf8");
		if (hash(current) !== expectedHash)
			throw new WorkbenchError("conflict", "Memory file changed since it was loaded");
		await this.commitWrite(kind, relativePath, projectId, content, undefined, expectedHash);
		return this.reindex(kind, relativePath, projectId);
	}

	async recoverAppliedCandidates(excludedProjects = new Set<string>()): Promise<MemoryCandidate[]> {
		await this.recoverWrites(excludedProjects);
		const recovered: MemoryCandidate[] = [];
		for (const candidate of await this.repository.listCandidates("pending")) {
			if (candidate.projectId && excludedProjects.has(candidate.projectId)) continue;
			if (!candidate.appliedHash) continue;
			const classified = await this.pathPolicy.requireMemory(candidate.relativePath);
			const content = await readFile(classified.absolutePath, "utf8");
			const currentHash = hash(content);
			if (currentHash !== candidate.appliedHash) {
				recovered.push(await this.resolveCandidate(candidate, "conflicted"));
				continue;
			}
			const indexed = await this.buildIndex(candidate.kind, candidate.projectId, candidate.relativePath, content);
			const accepted: MemoryCandidate = {
				...candidate,
				status: "accepted",
				updatedAt: toTimestamp(this.system.now()),
				resolvedAt: toTimestamp(this.system.now()),
			};
			await this.repository.completeCandidate(accepted, indexed.file, indexed.entries);
			recovered.push(accepted);
		}
		return recovered;
	}

	private async resolveCandidate(
		candidate: MemoryCandidate,
		status: Extract<MemoryCandidate["status"], "rejected" | "conflicted">,
	): Promise<MemoryCandidate> {
		const now = toTimestamp(this.system.now());
		return this.repository.updateCandidate({ ...candidate, status, updatedAt: now, resolvedAt: now });
	}

	private async buildIndex(
		kind: MemoryKind,
		projectId: string | undefined,
		relativePath: string,
		content: string,
	): Promise<IndexedMemory> {
		const { absolutePath } = await this.pathPolicy.requireMemory(relativePath);
		const fileStat = await stat(absolutePath);
		const contentHash = hash(content);
		const now = toTimestamp(this.system.now());
		const memoryFileId = hash(`${kind}:${projectId ?? "global"}:${relativePath}`);
		const lines = withoutSemanticBlocks(
			kind === "project" && relativePath.endsWith("/AGENTS.md") ? withoutProjectContext(content) : content,
		).split(/\r?\n/u);
		const entries: MemoryIndexEntry[] = [];
		let heading: string | undefined;
		let startLine = 1;
		let buffer: string[] = [];
		const separateEntries = kind !== "daily";
		const headings: Array<{ level: number; text: string }> = [];
		let listEntry = false;
		let html: string | undefined;
		let fence: string | undefined;
		const flush = (endLine: number) => {
			const chunk = buffer.join("\n").trim();
			if (chunk) {
				const chunkHash = hash(chunk);
				entries.push({
					id: hash(`${memoryFileId}:${heading ?? ""}:${startLine}:${endLine}:${chunkHash}`),
					memoryFileId,
					projectId,
					kind,
					heading,
					startLine,
					endLine,
					content: chunk,
					contentHash: chunkHash,
					occurredOn: kind === "daily" ? relativePath.slice(7, 17) : undefined,
					createdAt: now,
				});
			}
			buffer = [];
			listEntry = false;
		};
		for (let index = 0; index < lines.length; index += 1) {
			if (separateEntries) {
				const line = lines[index];
				const delimiter = html ? undefined : /^\s*(`{3,}|~{3,})/u.exec(line)?.[1];
				if (delimiter) {
					if (!fence) fence = delimiter;
					else if (delimiter[0] === fence[0] && delimiter.length >= fence.length) fence = undefined;
					buffer.push(line);
					continue;
				}
				if (fence) {
					buffer.push(line);
					continue;
				}
				if (html || /^\s*(?:<!doctype\s+html\b|<(?:html|svg)\b)/iu.test(line)) {
					html ??= /<svg\b/iu.test(line) ? "svg" : "html";
					buffer.push(line);
					if (line.toLowerCase().includes(`</${html}>`)) html = undefined;
					continue;
				}
				if (!line.trim() && listEntry) {
					buffer.push(line);
					continue;
				}
				if (!line.trim() || /^\s*<!--.*-->\s*$/u.test(line)) {
					flush(index);
					startLine = index + 2;
					continue;
				}
				if (/^(?:[-*+] |\d+[.)] )/u.test(line)) {
					flush(index);
					startLine = index + 1;
					listEntry = true;
				}
			}
			const match = /^(#{1,6})\s+(.+)$/u.exec(lines[index]);
			if (match) {
				flush(index);
				while (headings.length && headings.at(-1)!.level >= match[1].length) headings.pop();
				headings.push({ level: match[1].length, text: lines[index] });
				heading = separateEntries ? headings.map((item) => item.text).join("\n") : match[2].trim();
				startLine = index + (separateEntries ? 2 : 1);
				buffer = separateEntries ? [] : [lines[index]];
			} else {
				buffer.push(lines[index]);
			}
		}
		flush(lines.length);
		return {
			file: {
				id: memoryFileId,
				kind,
				projectId,
				relativePath,
				contentHash,
				size: fileStat.size,
				modifiedAt: fileStat.mtime.toISOString(),
				indexedAt: now,
				version: 1,
			},
			entries,
		};
	}

	private async commitWrite(
		kind: MemoryKind,
		relativePath: string,
		projectId: string | undefined,
		after: string | null,
		candidateId?: string,
		expectedHash?: string | null,
	): Promise<void> {
		if (this.writes.has(relativePath)) throw new WorkbenchError("conflict", "记忆文件正在更新");
		this.writes.add(relativePath);
		try {
			const target = await this.pathPolicy.requireMemory(relativePath);
			const before = await readFile(target.absolutePath, "utf8").catch((error: unknown) => {
				if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return null;
				throw error;
			});
			if (expectedHash !== undefined && (before === null ? null : hash(before)) !== expectedHash)
				throw new WorkbenchError("conflict", "记忆文件在提交前变化，不会覆盖");
			const intent = {
				id: this.system.id(),
				kind,
				relativePath,
				projectId,
				candidateId,
				before,
				after,
				beforeHash: before === null ? null : hash(before),
				afterHash: after === null ? null : hash(after),
				status: "prepared" as const,
				createdAt: toTimestamp(this.system.now()),
			};
			await this.durability?.saveWriteIntent(intent);
			if (before !== null) {
				const archive = await this.pathPolicy.requireWorkspace(
					`memory/history/files/${hash(relativePath)}/${intent.id}.md`,
				);
				await writeTextAtomically(archive.absolutePath, before);
			}
			const checked = await readFile(target.absolutePath, "utf8").catch((error: unknown) => {
				if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return null;
				throw error;
			});
			if (checked !== before) {
				await this.durability?.finishWriteIntent(intent.id, "conflicted");
				throw new WorkbenchError("conflict", "保存期间记忆文件被外部修改");
			}
			if (after === null) {
				if (before !== null) await unlink(target.absolutePath);
				await this.repository.deleteFile(kind, projectId, relativePath);
				await this.durability?.replaceSemantics(relativePath, []);
			} else {
				await writeTextAtomically(target.absolutePath, after);
				await this.reindex(kind, relativePath, projectId, true);
			}
			await this.durability?.finishWriteIntent(intent.id, "applied");
		} finally {
			this.writes.delete(relativePath);
		}
	}
	async recoverWrites(excludedProjects = new Set<string>()): Promise<void> {
		for (const intent of (await this.durability?.listWriteIntents()) ?? []) {
			if (intent.projectId && excludedProjects.has(intent.projectId)) continue;
			const target = await this.pathPolicy.requireMemory(intent.relativePath);
			const current = await readFile(target.absolutePath, "utf8").catch((error: unknown) => {
				if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return null;
				throw error;
			});
			const currentHash = current === null ? null : hash(current);
			if (currentHash !== intent.beforeHash && currentHash !== intent.afterHash) {
				await this.durability!.finishWriteIntent(intent.id, "conflicted");
				if (intent.candidateId)
					await this.resolveCandidate(await this.getCandidate(intent.candidateId), "conflicted");
				continue;
			}
			if (intent.before !== null) {
				const archive = await this.pathPolicy.requireWorkspace(
					`memory/history/files/${hash(intent.relativePath)}/${intent.id}.md`,
				);
				await writeTextAtomically(archive.absolutePath, intent.before);
			}
			if (currentHash !== intent.afterHash) {
				if (intent.after === null) {
					if (current !== null) await unlink(target.absolutePath);
				} else await writeTextAtomically(target.absolutePath, intent.after);
			}
			if (intent.after === null) {
				await this.repository.deleteFile(intent.kind, intent.projectId, intent.relativePath);
				await this.durability!.replaceSemantics(intent.relativePath, []);
			} else {
				const file = await this.reindex(intent.kind, intent.relativePath, intent.projectId, true);
				if (intent.candidateId) {
					const candidate = await this.getCandidate(intent.candidateId);
					await this.repository.updateCandidate({
						...candidate,
						appliedHash: file.contentHash,
						status: "accepted",
						updatedAt: toTimestamp(this.system.now()),
						resolvedAt: toTimestamp(this.system.now()),
					});
				}
			}
			await this.durability!.finishWriteIntent(intent.id, "applied");
		}
	}
}
