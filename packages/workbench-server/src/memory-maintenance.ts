import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
	MemoryIntelligence,
	type MemoryService,
	type MemorySummarySource,
	memoryAgeNotice,
	memoryConfidence,
	memoryPolicy,
	type PathPolicy,
	type Project,
	type ProjectLearningService,
	type ProjectService,
	type SemanticMemoryService,
	type SettingsService,
	type SkillService,
	WorkbenchError,
	type WorkbenchPaths,
	writeTextAtomically,
} from "@earendil-works/workbench-core";
import type { AgentRuntime, RuntimeModelRef } from "@earendil-works/workbench-runtime";

interface DigestEntry extends Omit<MemorySummarySource, "text"> {
	summary: string;
}
interface Digest {
	path: string;
	generatedAt: string;
	hash: string;
	entries: DigestEntry[];
}
interface Dependencies {
	paths: WorkbenchPaths;
	policy: PathPolicy;
	settings: SettingsService;
	projects: ProjectService;
	memory: MemoryService;
	semantic: SemanticMemoryService;
	learning: ProjectLearningService;
	skills: SkillService;
	runtime: AgentRuntime;
	model(): Promise<RuntimeModelRef | undefined>;
	onError(message: string): Promise<void>;
}
const hash = (text: string) => createHash("sha256").update(text).digest("hex");

/** Derived indexes never replace their structured source or evidence. */
export class MemoryMaintenanceService {
	private readonly options: Dependencies;
	private readonly intelligence: MemoryIntelligence;
	private timer?: ReturnType<typeof setInterval>;
	private active?: Promise<void>;
	private readonly controller = new AbortController();
	constructor(options: Dependencies) {
		this.options = options;
		this.intelligence = new MemoryIntelligence(options.runtime, options.paths.runtime);
	}
	async start(): Promise<void> {
		if (!(await this.options.settings.get("memory.maintenance.startedAt")))
			await this.options.settings.set("memory.maintenance.startedAt", new Date().toISOString());
		this.timer = setInterval(() => {
			void this.run().catch((error: unknown) =>
				this.options.onError(
					error instanceof WorkbenchError ? error.message : "记忆定时维护失败，保留原文与上次索引",
				),
			);
		}, 60_000);
		this.timer.unref();
	}
	async dispose(): Promise<void> {
		clearInterval(this.timer);
		this.controller.abort();
		await this.active?.catch(() => undefined);
	}
	run(force = false): Promise<void> {
		if (this.active) return this.active;
		this.active = this.process(force).finally(() => {
			this.active = undefined;
		});
		return this.active;
	}
	private async process(force: boolean): Promise<void> {
		const signal = this.controller.signal;
		signal.throwIfAborted();
		const policy = memoryPolicy((await this.options.settings.get("memory.policy"))?.value);
		const started = (await this.options.settings.get("memory.maintenance.startedAt"))?.value;
		const completed = (await this.options.settings.get("memory.maintenance.completedAt"))?.value;
		const attempted = (await this.options.settings.get("memory.maintenance.attemptedAt"))?.value;
		const now = new Date().toISOString();
		if (
			!force &&
			(Date.now() - Date.parse(String(completed ?? started ?? now)) < policy.consolidationIntervalHours * 3600000 ||
				(attempted && Date.now() - Date.parse(String(attempted)) < 3600000))
		)
			return;
		const projects = (await this.options.projects.list()).filter((project) => project.status === "active");
		if (
			await Promise.all(projects.map((project) => this.options.learning.isBusy(project.id))).then((values) =>
				values.some(Boolean),
			)
		) {
			if (force) throw new WorkbenchError("conflict", "经验提取仍在运行，请完成后再浓缩");
			return;
		}
		await this.options.settings.set("memory.maintenance.attemptedAt", now);
		for (const project of [undefined, ...projects]) {
			signal.throwIfAborted();
			await this.options.memory.refreshIndex({ project });
			await this.options.semantic.retireLowConfidence({ project });
			const sources = await this.sources(project);
			const entries: DigestEntry[] = [];
			const model = await this.options.model();
			for (let offset = 0; offset < sources.length; offset += 12) {
				const batch = sources.slice(offset, offset + 12);
				const summaries = await this.intelligence.condense(batch, policy.maxEntryCharacters, model, signal);
				for (const source of batch)
					entries.push({
						id: source.id,
						path: source.path,
						timestamp: source.timestamp,
						confidence: source.confidence,
						version: source.version,
						hash: source.hash,
						summary: summaries.find((entry) => entry.id === source.id)!.text,
					});
			}
			await this.options.memory.refreshIndex({ project });
			const refreshed = await this.sources(project);
			if (JSON.stringify(refreshed) !== JSON.stringify(sources))
				throw new WorkbenchError("conflict", "浓缩期间原始记忆已变化，下次重新加工");
			const path = project ? `projects/${project.slug}/memory/main.md` : "memory/main.md";
			const generatedAt = new Date().toISOString();
			const content = [
				"---",
				"name: memory-index",
				'description: "渐进式记忆索引；按需读取来源与证据"',
				`updated_at: ${generatedAt}`,
				"---",
				"",
				"# 记忆索引",
				"",
				...entries.flatMap((entry) => [
					`- ${entry.summary}`,
					`  - 时间：${entry.timestamp}；置信度：${entry.confidence}；版本：${entry.version}；来源：${entry.path}；ID：${entry.id}${memoryAgeNotice(entry.timestamp, policy) ? `；${memoryAgeNotice(entry.timestamp, policy)}` : ""}`,
				]),
				"",
			].join("\n");
			const target = await this.options.policy.requireWorkspace(path);
			const normalize = (value: string) =>
				process.platform === "win32" ? resolve(value).toLowerCase() : resolve(value);
			if (normalize(target.absolutePath) !== normalize(target.realPath))
				throw new WorkbenchError("path_denied", "记忆索引路径不能包含链接");
			await writeTextAtomically(target.absolutePath, content);
			const digest: Digest = { path, generatedAt, hash: hash(content), entries };
			await this.options.settings.set(`memory.digest.${project?.id ?? "global"}`, {
				...digest,
				entries: entries.map((entry) => ({ ...entry })),
			});
		}
		await this.options.settings.set("memory.maintenance.completedAt", new Date().toISOString());
	}
	async read(project?: Project): Promise<DigestEntry[]> {
		const policy = memoryPolicy((await this.options.settings.get("memory.policy"))?.value);
		const entries: DigestEntry[] = [];
		for (const scope of [undefined, ...(project ? [project] : [])]) {
			const raw = (await this.options.settings.get(`memory.digest.${scope?.id ?? "global"}`))?.value;
			if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
			const digest = raw as unknown as Digest;
			const expectedPath = scope ? `projects/${scope.slug}/memory/main.md` : "memory/main.md";
			if (digest.path !== expectedPath || !Array.isArray(digest.entries)) continue;
			const target = await this.options.policy.requireWorkspace(expectedPath);
			const content = await readFile(target.absolutePath, "utf8").catch((error: unknown) => {
				if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return "";
				throw error;
			});
			if (hash(content) !== digest.hash) continue;
			const current = new Map((await this.sources(scope)).map((source) => [source.id, source]));
			entries.push(
				...digest.entries.filter((entry) => {
					if (!entry || typeof entry.summary !== "string" || !entry.summary.trim()) return false;
					const source = current.get(entry.id);
					return (
						source &&
						source.hash === entry.hash &&
						source.version === entry.version &&
						source.confidence >= policy.confidenceThreshold &&
						Array.from(entry.summary).length <= policy.maxEntryCharacters
					);
				}),
			);
		}
		return entries;
	}
	private async sources(project?: Project): Promise<MemorySummarySource[]> {
		const sources: MemorySummarySource[] = (await this.options.semantic.list({ project }))
			.filter((fact) => fact.projectId === project?.id && fact.conflict === "none")
			.map((fact) => ({
				id: fact.id,
				text: fact.text,
				path: fact.relativePath,
				timestamp: fact.lastVerifiedAt ?? fact.updatedAt,
				confidence: memoryConfidence(fact),
				version: fact.version,
				hash: fact.contentHash,
			}));
		if (project) {
			for (const item of (await this.options.learning.experiences(project.id)).skills) {
				if (!item.skill.enabled || item.management?.status !== "managed") continue;
				const state = item.management;
				const policy = memoryPolicy((await this.options.settings.get("memory.policy"))?.value);
				if ((state.confidence ?? 0.85) < policy.confidenceThreshold) continue;
				const body = await this.options.skills.readContent(item.skill.id);
				sources.push({
					id: item.skill.id,
					text: body.content,
					path: item.skill.path,
					timestamp: state.lastVerifiedAt ?? state.updatedAt,
					confidence: state.confidence ?? 0.85,
					version: state.version,
					hash: body.hash,
				});
			}
		}
		return sources.sort((a, b) => a.id.localeCompare(b.id));
	}
}
