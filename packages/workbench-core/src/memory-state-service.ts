import type { AgentEvent, AgentRuntime, RuntimeTranscriptMessage } from "@earendil-works/workbench-runtime";
import type { WorkingSummaryOutput } from "./contracts/learning.ts";
import { WorkbenchError } from "./errors.ts";
import { redactLearningText } from "./evidence-redaction.ts";
import type { LearningSource } from "./learning.ts";
import { learningSourceMatches } from "./learning-evidence.ts";
import type {
	EpisodeQuery,
	EpisodicMemory,
	MemoryEvidence,
	MemoryStateRepository,
	WorkingCheckpoint,
} from "./memory-layers.ts";
import type { AgentRun, WorkbenchSession } from "./models.ts";
import type { ArtifactRepository, SessionRepository, TaskRunRepository } from "./repositories.ts";
import type { SemanticEmbeddingPort } from "./semantic-memory.ts";
import { defaultSystemServices, type SystemServices } from "./system.ts";

const checkpointLifetime = 30 * 24 * 60 * 60 * 1000;
const bounded = (text: string, limit = 1000) => redactLearningText(text).slice(0, limit);
const nextStepLine = /^\s*(?:下一步|待办|next\s+steps?|todo)\s*[:：]\s*\S/iu;

/** Stores compact evidence at boundaries. It never stores token deltas, reasoning or tool arguments. */
export class MemoryStateService {
	private readonly repository: MemoryStateRepository;
	private readonly sessions: SessionRepository;
	private readonly taskRuns: TaskRunRepository;
	private readonly artifacts: ArtifactRepository;
	private readonly runtime: AgentRuntime;
	private readonly system: SystemServices;
	private readonly embedding?: SemanticEmbeddingPort;
	private readonly outcomes = new Map<string, AgentEvent>();
	constructor(options: {
		repository: MemoryStateRepository;
		sessions: SessionRepository;
		taskRuns: TaskRunRepository;
		artifacts: ArtifactRepository;
		runtime: AgentRuntime;
		system?: SystemServices;
		embedding?: SemanticEmbeddingPort;
	}) {
		this.repository = options.repository;
		this.sessions = options.sessions;
		this.taskRuns = options.taskRuns;
		this.artifacts = options.artifacts;
		this.runtime = options.runtime;
		this.system = options.system ?? defaultSystemServices;
		this.embedding = options.embedding;
	}
	async initializeRecovery(): Promise<void> {
		const at = this.system.now().toISOString();
		await this.repository.interruptRunning(at);
		for (const checkpoint of await this.repository.interruptedCheckpoints()) {
			if (!checkpoint.runId || (await this.repository.getRunEpisode(checkpoint.runId))) continue;
			await this.repository.saveEpisode({
				id: this.system.id(),
				sessionId: checkpoint.sessionId,
				projectId: checkpoint.projectId,
				runId: checkpoint.runId,
				taskId: checkpoint.taskId,
				occurredAt: at,
				summary: bounded(checkpoint.goal, 600),
				actions: [],
				result: "运行被进程重启中断，结果尚未验证；已保留最近可靠边界的检查点和证据。",
				outcome: "interrupted",
				sources: checkpoint.sources,
				semanticIds: [],
				skillIds: [],
				retention: "keep",
				version: 1,
				updatedAt: at,
			});
		}
		await this.repository.cleanupExpired(at);
	}
	async checkpoint(sessionId: string): Promise<WorkingCheckpoint | undefined> {
		await this.requireSession(sessionId);
		const value = await this.repository.getCheckpoint(sessionId);
		return value && (value.status === "running" || value.expiresAt > this.system.now().toISOString())
			? value
			: undefined;
	}
	async begin(session: WorkbenchSession, run: AgentRun, text: string): Promise<void> {
		const old = await this.checkpoint(session.id);
		const now = this.system.now();
		const task = run.taskRunId ? await this.taskRuns.get(run.taskRunId) : undefined;
		const continuation =
			/^\s*(?:(?:重启|压缩|恢复)(?:之后|以后|后)[，,\s]*(?:请)?\s*)?(?:继续|接着|恢复|continue\b|resume\b)/iu.test(
				text,
			);
		const nextSteps = text
			.split(/\r?\n/)
			.filter((line) => nextStepLine.test(line))
			.map((line) => bounded(line, 400));
		const retainedSteps = continuation ? (old?.nextSteps.filter((line) => nextStepLine.test(line)) ?? []) : [];
		const value: WorkingCheckpoint = {
			sessionId: session.id,
			projectId: session.projectId,
			taskId: task?.taskId,
			runId: run.id,
			branchId: old?.branchId,
			sourceSequence: (old?.sourceSequence ?? 0) + 1,
			goal: continuation && old ? old.goal : bounded(text, 1600),
			completedSteps: old?.completedSteps ?? [],
			nextSteps: nextSteps.length
				? nextSteps.slice(-6)
				: retainedSteps.length
					? retainedSteps
					: [bounded(text, 800)],
			constraints: [
				...new Set([
					...(old?.constraints ?? []),
					...text
						.split(/\r?\n/)
						.filter((line) => /^\s*(?:约束|限制|必须|不要|禁止|constraint|must|never)\s*[:：]?/iu.test(line))
						.map((line) => bounded(line, 400)),
				]),
			].slice(-12),
			temporaryConclusions: old?.temporaryConclusions ?? [],
			unresolvedQuestions: [
				...new Set([
					...(old?.unresolvedQuestions ?? []),
					...text
						.split(/\r?\n/)
						.filter((line) =>
							/^\s*(?:未解决问题|待确认问题|未确认事项|unresolved(?:\s+questions?)?|open\s+questions?)\s*[:：]\s*\S/iu.test(
								line,
							),
						)
						.map((line) => bounded(line, 400)),
				]),
			].slice(-12),
			sources: [
				...(old?.sources ?? []),
				{
					kind: "message" as const,
					id: run.inputMessageId,
					sessionId: session.id,
					runId: run.id,
					excerpt: bounded(text, 400),
					confirmation: "user_confirmed" as const,
					availability: "present" as const,
				},
			].slice(-20),
			status: "running",
			version: (old?.version ?? 0) + 1,
			updatedAt: now.toISOString(),
			expiresAt: new Date(now.getTime() + checkpointLifetime).toISOString(),
		};
		// An expired record still participates in CAS until explicit cleanup.
		const stored = await this.repository.getCheckpoint(session.id);
		value.version = (stored?.version ?? 0) + 1;
		if (!(await this.repository.saveCheckpoint(value, stored?.version ?? 0)))
			throw new WorkbenchError("conflict", "检查点已更新，请重试");
	}
	async observe(event: AgentEvent): Promise<void> {
		if (["run.completed", "run.failed", "run.aborted"].includes(event.type)) {
			this.outcomes.set(event.runId, event);
			return;
		}
		if (
			event.type !== "tool.completed" &&
			!(event.type === "message.started" && event.data.role === "user" && event.data.steering)
		)
			return;
		const old = await this.repository.getCheckpoint(event.sessionId);
		if (!old || old.runId !== event.runId || old.status !== "running") return;
		const value = {
			...old,
			version: old.version + 1,
			updatedAt: this.system.now().toISOString(),
			sourceSequence: old.sourceSequence + 1,
		};
		if (event.type === "tool.completed") {
			const results = toolEvidence(event.data.result, event.data.isError);
			const text = results.text;
			if (!results.failed)
				value.completedSteps = [...old.completedSteps, `${event.data.toolName}: ${text}`].slice(-12);
			else
				value.unresolvedQuestions = [...old.unresolvedQuestions, `工具 ${event.data.toolName} 失败：${text}`].slice(
					-12,
				);
			value.sources = [
				...old.sources,
				{
					kind: "tool" as const,
					id: event.data.toolCallId,
					toolCallId: event.data.toolCallId,
					sessionId: event.sessionId,
					runId: event.runId,
					excerpt: text,
					confirmation: results.failed ? ("unverified" as const) : ("verified" as const),
					availability: "present" as const,
				},
			].slice(-20);
		} else if (event.data.text) value.nextSteps = [bounded(event.data.text, 800)];
		await this.repository.saveCheckpoint(value, old.version);
	}
	async settle(session: WorkbenchSession, run: AgentRun): Promise<void> {
		const terminal = this.outcomes.get(run.id);
		this.outcomes.delete(run.id);
		const messages = await this.runtime.readTranscriptReference({
			reference: {
				runtime: session.runtime,
				runtimeSessionId: session.runtimeSessionId,
				opaque: session.runtimeRef,
			},
			expectedCwd: session.cwd,
			kind: session.kind,
		});
		const selected = messages.filter(
			(m) => m.timestamp >= run.startedAt && (!run.settledAt || m.timestamp <= run.settledAt),
		);
		const old = await this.repository.getCheckpoint(session.id);
		if (!old || old.runId !== run.id) return;
		const sources = transcriptEvidence(selected, session.id, run.id);
		const toolMessages = selected.filter((m) => m.role === "tool");
		const actions = toolMessages
			.map((m) => {
				const result = toolEvidence(
					m.evidenceText ??
						m.content
							.filter((c) => c.type === "text")
							.map((c) => c.text ?? "")
							.join("\n"),
					Boolean(m.isError),
				);
				return {
					tool: m.toolName ?? "tool",
					result: result.text,
					verified: !result.failed,
					toolCallId: m.toolCallId,
				};
			})
			.slice(-16);
		const final = [...selected].reverse().find((m) => m.role === "assistant");
		const result = bounded(
			final?.content
				.filter((c) => c.type === "text")
				.map((c) => c.text ?? "")
				.join("\n") ??
				run.errorMessage ??
				"未产生最终回答",
			1500,
		);
		const acceptance = terminal?.type === "run.completed" ? terminal.data.acceptance : undefined;
		const outcome: EpisodicMemory["outcome"] =
			run.status === "failed"
				? "failure"
				: run.status === "aborted"
					? "cancelled"
					: run.status === "interrupted"
						? "interrupted"
						: acceptance?.status === "accepted"
							? "success"
							: actions.some((a) => !a.verified)
								? "failure"
								: "unverified";
		const artifacts = (await this.artifacts.list(session.projectId))
			.filter((a) => a.sessionId === session.id && a.createdAt >= run.startedAt)
			.slice(-8);
		sources.push(
			...artifacts.map((a) => ({
				kind: "artifact" as const,
				id: a.id,
				path: a.relativePath,
				sessionId: session.id,
				runId: run.id,
				confirmation: "verified" as const,
				availability: "present" as const,
			})),
		);
		const now = this.system.now().toISOString();
		if (
			actions.length ||
			artifacts.length ||
			/记住|纠正|决定|失败|迁移|完成|implement|fix|remember/iu.test(old.goal)
		) {
			await this.repository.saveEpisode({
				id: this.system.id(),
				projectId: session.projectId,
				sessionId: session.id,
				runId: run.id,
				taskId: old.taskId,
				occurredAt: run.settledAt ?? now,
				summary: bounded(old.goal, 600),
				actions,
				result,
				outcome,
				sources,
				semanticIds: [],
				skillIds: [],
				retention: "keep",
				version: 1,
				updatedAt: now,
			});
		}
		const value: WorkingCheckpoint = {
			...old,
			status:
				run.status === "aborted"
					? "cancelled"
					: run.status === "failed"
						? "failed"
						: run.status === "interrupted"
							? "interrupted"
							: "completed",
			branchId: selected.at(-1)?.piEntryId ?? old.branchId,
			sources: sources.length ? sources.slice(-20) : old.sources,
			temporaryConclusions: result ? [{ text: result, confirmation: "unverified" }] : [],
			// Completing this run does not resolve a user-declared future step.
			nextSteps: outcome === "success" ? old.nextSteps.filter((line) => nextStepLine.test(line)) : old.nextSteps,
			unresolvedQuestions:
				outcome === "failure" && !old.unresolvedQuestions.length
					? [bounded(run.errorMessage ?? "本轮包含失败操作，需要确认结果")]
					: old.unresolvedQuestions,
			version: old.version + 1,
			sourceSequence: old.sourceSequence + 1,
			updatedAt: now,
		};
		await this.repository.saveCheckpoint(value, old.version);
	}
	async episodes(
		sessionId: string,
		query: Omit<EpisodeQuery, "projectId"> = {},
		embedding?: SemanticEmbeddingPort,
		signal?: AbortSignal,
	): Promise<EpisodicMemory[]> {
		const session = await this.requireSession(sessionId);
		const scope = {
			...query,
			projectId: session.projectId,
			sessionId: session.projectId ? query.sessionId : sessionId,
		};
		let values = await this.repository.queryEpisodes(scope);
		if (query.query && embedding && (await this.repository.hasEpisodeVectors(scope))) {
			const value = await embedding.embed(query.query, signal);
			const vectors = await this.repository.searchEpisodeVectors(scope, value.fingerprint, value.vector);
			const ranked = new Map<string, { value: EpisodicMemory; score: number }>();
			for (const group of [values, vectors])
				for (const [index, episode] of group.entries())
					ranked.set(episode.id, {
						value: episode,
						score: (ranked.get(episode.id)?.score ?? 0) + 1 / (60 + index),
					});
			values = [...ranked.values()]
				.sort((a, b) => b.score - a.score || b.value.occurredAt.localeCompare(a.value.occurredAt))
				.slice(0, query.limit ?? 20)
				.map((item) => item.value);
		}
		const references = new Map<string, Promise<RuntimeTranscriptMessage[]>>();
		for (const episode of values) {
			for (const source of episode.sources.filter((item) => item.kind === "message" || item.kind === "tool")) {
				const id = source.sessionId ?? episode.sessionId;
				if (!references.has(id)) references.set(id, this.sourceTranscript(id));
				const messages = await references.get(id)!;
				const present = messages.some((message) =>
					source.piEntryId
						? message.piEntryId === source.piEntryId
						: message.id === source.id || Boolean(source.toolCallId && message.toolCallId === source.toolCallId),
				);
				source.availability = present ? "present" : source.excerpt ? "retained_excerpt" : "missing";
			}
		}
		return values;
	}
	async rebuildVectors(sessionId: string, signal?: AbortSignal): Promise<number> {
		const session = await this.requireSession(sessionId);
		if (!this.embedding || !(await this.embedding.fingerprint()))
			throw new WorkbenchError("conflict", "缺少文本 Embedding；经历仍可按关键词与时间检索");
		const values = await this.repository.queryEpisodes({
			projectId: session.projectId,
			sessionId: session.projectId ? undefined : sessionId,
			limit: 10000,
		});
		for (const value of values) {
			signal?.throwIfAborted();
			const embedded = await this.embedding.embed(
				`${value.summary}\n${value.result}\n${value.actions.map((action) => action.result).join("\n")}`,
				signal,
			);
			await this.repository.saveEpisodeVector(value.id, value.version, embedded.fingerprint, embedded.vector);
		}
		return values.length;
	}
	private async sourceTranscript(id: string): Promise<RuntimeTranscriptMessage[]> {
		const session = await this.sessions.get(id);
		if (!session || session.deletionRequestedAt) return [];
		return this.runtime
			.readTranscriptReference({
				reference: {
					runtime: session.runtime,
					runtimeSessionId: session.runtimeSessionId,
					opaque: session.runtimeRef,
				},
				expectedCwd: session.cwd,
				kind: session.kind,
			})
			.catch(() => []);
	}
	async deleteEpisode(id: string, sessionId: string): Promise<void> {
		await this.exportEpisode(id, sessionId);
		if (!(await this.repository.deleteEpisode(id)))
			throw new WorkbenchError("conflict", "事件已被事实或 Skill 引用，需保留证据");
	}
	async evidence(sessionId: string, index: number, episodeId?: string): Promise<MemoryEvidence> {
		const checkpoint = await this.checkpoint(sessionId);
		if (episodeId) await this.exportEpisode(episodeId, sessionId);
		const source = (episodeId ? (await this.repository.getEpisode(episodeId))?.sources : checkpoint?.sources)?.[
			index
		];
		if (!source) throw new WorkbenchError("not_found", "来源不存在");
		if (source.kind !== "message" && source.kind !== "tool") return source;
		const messages = await this.sourceTranscript(source.sessionId ?? sessionId);
		const message = messages.find((value) =>
			source.piEntryId
				? value.piEntryId === source.piEntryId
				: value.id === source.id || Boolean(source.toolCallId && value.toolCallId === source.toolCallId),
		);
		return {
			...source,
			availability: message ? "present" : source.excerpt ? "retained_excerpt" : "missing",
			excerpt: message
				? transcriptEvidence([message], source.sessionId ?? sessionId, source.runId ?? "")[0]?.excerpt
				: source.excerpt,
		};
	}
	async exportEpisode(id: string, sessionId: string): Promise<string> {
		const session = await this.requireSession(sessionId);
		const episode = await this.repository.getEpisode(id);
		if (
			!episode ||
			episode.projectId !== session.projectId ||
			(!session.projectId && episode.sessionId !== sessionId)
		)
			throw new WorkbenchError("not_found", "事件不存在");
		for (const source of episode.sources.filter((item) => item.kind === "message" || item.kind === "tool")) {
			const messages = await this.sourceTranscript(source.sessionId ?? episode.sessionId);
			const present = messages.some((message) =>
				source.piEntryId
					? message.piEntryId === source.piEntryId
					: message.id === source.id || Boolean(source.toolCallId && message.toolCallId === source.toolCallId),
			);
			source.availability = present ? "present" : source.excerpt ? "retained_excerpt" : "missing";
		}
		return [
			`# ${episode.summary}`,
			"",
			`事件：${episode.id} · 运行：${episode.runId} · ${episode.occurredAt} · ${episode.outcome}`,
			"",
			episode.result,
			"",
			"## 操作与证据",
			"",
			...episode.actions.map((a) => `- ${a.verified ? "已验证工具结果" : "未验证"} ${a.tool}: ${a.result}`),
			"",
			...episode.sources.map(
				(s) =>
					`- ${s.kind}:${s.piEntryId ?? s.id} (${s.confirmation}, ${s.availability})\n  ${s.excerpt ?? s.path ?? ""}`,
			),
		].join("\n");
	}
	async cleanup(): Promise<number> {
		return this.repository.cleanupExpired(this.system.now().toISOString());
	}
	async markReview(
		sessionId: string,
		runId: string,
		status: NonNullable<WorkingCheckpoint["review"]>["status"],
		error?: string,
	): Promise<WorkingCheckpoint | undefined> {
		const old = await this.repository.getCheckpoint(sessionId);
		if (!old || old.runId !== runId || old.status === "running") return undefined;
		return this.repository.saveCheckpoint(
			{
				...old,
				review: { status, error: error ? bounded(error) : undefined },
				version: old.version + 1,
				updatedAt: this.system.now().toISOString(),
			},
			old.version,
		);
	}
	async applySummary(
		sessionId: string,
		runId: string,
		expectedVersion: number,
		summary: WorkingSummaryOutput,
		sources: LearningSource[],
	): Promise<boolean> {
		const old = await this.repository.getCheckpoint(sessionId);
		if (!old || old.runId !== runId || old.version !== expectedVersion || old.status === "running") return false;
		const valid = (item: WorkingSummaryOutput["completedSteps"][number], role?: LearningSource["role"]) =>
			item.evidence.every((evidence) => {
				const matches = learningSourceMatches(sources, evidence.sourceId);
				const source = matches.length === 1 ? matches[0] : undefined;
				return (
					evidence.quote.trim().length >= 4 &&
					source?.text.includes(evidence.quote) &&
					(!role || (source.role === role && source.verified && source.text.includes(item.text)))
				);
			});
		const texts = (items: WorkingSummaryOutput["completedSteps"], role?: LearningSource["role"]) =>
			items.filter((item) => valid(item, role)).map((item) => bounded(item.text, 600));
		const value: WorkingCheckpoint = {
			...old,
			goal: summary.goal && valid(summary.goal, "user") ? bounded(summary.goal.text, 1600) : old.goal,
			completedSteps: [...new Set([...old.completedSteps, ...texts(summary.completedSteps, "tool")])].slice(-12),
			constraints: [...new Set([...old.constraints, ...texts(summary.constraints, "user")])].slice(-12),
			nextSteps: texts(summary.nextSteps).length ? texts(summary.nextSteps) : old.nextSteps,
			unresolvedQuestions: [...new Set([...old.unresolvedQuestions, ...texts(summary.unresolvedQuestions)])].slice(
				-12,
			),
			temporaryConclusions: texts(summary.temporaryConclusions).map((text) => ({
				text,
				confirmation: "unverified",
			})),
			review: { status: "complete" },
			version: old.version + 1,
			updatedAt: this.system.now().toISOString(),
		};
		return Boolean(await this.repository.saveCheckpoint(value, old.version));
	}
	private async requireSession(id: string): Promise<WorkbenchSession> {
		const session = await this.sessions.get(id);
		if (!session || session.deletionRequestedAt) throw new WorkbenchError("not_found", "会话不存在");
		return session;
	}
}

export function transcriptEvidence(
	messages: RuntimeTranscriptMessage[],
	sessionId: string,
	runId: string,
): MemoryEvidence[] {
	return messages
		.filter((m) => m.role !== "assistant" || m.content.some((c) => c.type === "text"))
		.slice(-20)
		.map((m) => {
			const text =
				m.evidenceText ??
				m.content
					.filter((c) => c.type === "text")
					.map((c) => c.text ?? "")
					.join("\n");
			const result =
				m.role === "tool" ? toolEvidence(text, Boolean(m.isError)) : { text: bounded(text, 800), failed: false };
			return {
				kind: m.role === "tool" ? "tool" : "message",
				id: m.id,
				piEntryId: m.piEntryId,
				toolCallId: m.toolCallId,
				sessionId,
				runId,
				excerpt: result.text,
				confirmation:
					m.role === "user" ? "user_confirmed" : m.role === "tool" && !result.failed ? "verified" : "unverified",
				availability: "present",
			};
		});
}

/** PTC's successful outer invocation cannot verify a failed subcall. Parameters are omitted. */
export function toolEvidence(result: unknown, failed: boolean): { text: string; failed: boolean } {
	let value = result;
	if (typeof value === "string") {
		try {
			value = JSON.parse(value);
		} catch {
			return { text: bounded(String(value)), failed };
		}
	}
	if (typeof value !== "object" || value === null) return { text: bounded(String(value ?? "")), failed };
	const record = value as Record<string, unknown>;
	const details =
		typeof record.details === "object" && record.details !== null
			? (record.details as Record<string, unknown>)
			: undefined;
	const calls = Array.isArray(details?.ptcCalls)
		? details.ptcCalls
		: Array.isArray(record.results)
			? record.results
			: Array.isArray(record.calls)
				? record.calls
				: undefined;
	if (calls) {
		const results = calls.map((call) => {
			const c = typeof call === "object" && call !== null ? (call as Record<string, unknown>) : {};
			return toolEvidence(
				c.result ?? c.output ?? c.error,
				c.isError === true || c.status === "failed" || Boolean(c.error),
			);
		});
		return { text: bounded(results.map((r) => r.text).join("\n")), failed: failed || results.some((r) => r.failed) };
	}
	if (Array.isArray(record.content))
		return {
			text: bounded(
				record.content
					.filter((c) => typeof c === "object" && c !== null && "type" in c && c.type === "text" && "text" in c)
					.map((c) => (c as { text: string }).text)
					.join("\n"),
			),
			failed,
		};
	const { arguments: _arguments, args: _args, ...safe } = record;
	return { text: bounded(JSON.stringify(safe)), failed: failed || record.isError === true };
}

export function renderWorkingCheckpoint(value: WorkingCheckpoint, budget = 4000): string {
	const compact = {
		goal: value.goal.slice(0, 700),
		constraints: value.constraints.slice(-6).map((text) => text.slice(0, 140)),
		unresolvedQuestions: value.unresolvedQuestions.slice(-6).map((text) => text.slice(0, 140)),
		nextSteps: value.nextSteps.slice(-3).map((text) => text.slice(0, 140)),
		completedSteps: value.completedSteps.slice(-5).map((text) => text.slice(0, 120)),
		temporaryConclusions: value.temporaryConclusions
			.slice(-2)
			.map((item) => ({ ...item, text: item.text.slice(0, 200) })),
		sources: value.sources.slice(-5).map((source) => ({
			id: source.piEntryId ?? source.id,
			kind: source.kind,
			confirmation: source.confirmation,
			availability: source.availability,
		})),
		status: value.status,
		updatedAt: value.updatedAt,
	};
	const target = Math.max(600, budget - 300);
	while (JSON.stringify(compact).length > target) {
		if (compact.completedSteps.length) compact.completedSteps.pop();
		else if (compact.sources.length) compact.sources.pop();
		else if (compact.temporaryConclusions.length) compact.temporaryConclusions.pop();
		else if (compact.nextSteps.length > 1) compact.nextSteps.pop();
		else {
			compact.goal = compact.goal.slice(0, Math.floor(compact.goal.length * 0.8));
			compact.constraints = compact.constraints.map((text) => text.slice(0, Math.floor(text.length * 0.8)));
			compact.unresolvedQuestions = compact.unresolvedQuestions.map((text) =>
				text.slice(0, Math.floor(text.length * 0.8)),
			);
			compact.nextSteps = compact.nextSteps.map((text) => text.slice(0, Math.floor(text.length * 0.8)));
			if (
				!compact.goal &&
				compact.constraints.every((text) => !text) &&
				compact.unresolvedQuestions.every((text) => !text)
			)
				break;
		}
	}
	return `<workbench-working-memory version="${value.version}" session="${value.sessionId}">\n紧凑检查点，工具成功不等于任务完成。临时结论仍须验证。\n${JSON.stringify(compact)}\n</workbench-working-memory>`;
}
