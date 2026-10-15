import type {
	AgentEvent,
	AgentRuntime,
	DevelopmentState,
	RuntimeContextOptions,
	RuntimeInput,
	RuntimeInputQueue,
	RuntimeModel,
	RuntimeModelRef,
	RuntimeQueueAction,
	RuntimeSandboxPolicy,
	RuntimeSessionCommand,
	RuntimeSessionReference,
	RuntimeThinkingLevel,
	RuntimeTranscriptMessage,
	RuntimeTurnContext,
} from "@earendil-works/workbench-runtime";
import { isMinimalAssistant } from "./assistant-presets.ts";
import type { CapabilityService, ResolvedCapabilities } from "./capability-service.ts";
import type { ChatCapabilityCatalog, ChatSelection } from "./contracts/chat.ts";
import { WorkbenchError } from "./errors.ts";
import { type MemoryStateService, renderWorkingCheckpoint } from "./memory-state-service.ts";
import type { AgentProfile, AgentRun, Project, WorkbenchSession } from "./models.ts";
import type { AgentProfileRepository, AgentRunRepository, SessionRepository } from "./repositories.ts";
import type { SessionWorkspaceService } from "./session-workspace.ts";
import { defaultSystemServices, type SystemServices, toTimestamp } from "./system.ts";

export interface CreateWorkbenchSessionInput {
	runtime?: string;
	project?: Pick<Project, "id" | "workspacePath" | "sourcePath">;
	cwd?: string | ((sessionId: string) => string);
	profile: AgentProfile;
	title?: string;
	kind?: WorkbenchSession["kind"];
	context?: RuntimeContextOptions;
}

export interface SendWorkbenchMessageInput {
	text: string;
	images?: RuntimeInput["images"];
	attachments?: RuntimeInput["attachments"];
	attachmentText?: string;
	signal?: AbortSignal;
	inputMessageId: string;
	runId?: string;
	taskRunId?: string;
	context?: RuntimeContextOptions;
	turnContext?: RuntimeTurnContext;
	selection?: ChatSelection;
}

export class SessionService {
	private readonly sessions: SessionRepository;
	private readonly runs: AgentRunRepository;
	private readonly profiles: AgentProfileRepository;
	private readonly runtimes: ReadonlyMap<string, AgentRuntime>;
	private readonly capabilities?: CapabilityService;
	private readonly system: SystemServices;
	private readonly workspaces?: SessionWorkspaceService;
	private readonly onRecoveryError?: (sessionId: string, error: unknown) => Promise<void>;
	private readonly getSandboxPolicy?: () => Promise<RuntimeSandboxPolicy>;
	private readonly memoryState?: MemoryStateService;
	private readonly onSkillLoaded?: (
		sessionId: string,
		value: Parameters<NonNullable<RuntimeContextOptions["onSkillLoaded"]>>[0],
	) => Promise<void>;
	private readonly activeRuns = new Map<string, string>();
	private readonly attachedSessionIds = new Set<string>();
	private readonly sessionMutations = new Set<string>();
	private readonly preparingRuns = new Set<string>();
	private readonly pendingTitles = new Map<string, { controller: AbortController; completion: Promise<void> }>();

	constructor(options: {
		sessions: SessionRepository;
		runs: AgentRunRepository;
		profiles: AgentProfileRepository;
		runtimes: ReadonlyMap<string, AgentRuntime>;
		capabilities?: CapabilityService;
		onRecoveryError?: (sessionId: string, error: unknown) => Promise<void>;
		getSandboxPolicy?(): Promise<RuntimeSandboxPolicy>;
		memoryState?: MemoryStateService;
		onSkillLoaded?: (
			sessionId: string,
			value: Parameters<NonNullable<RuntimeContextOptions["onSkillLoaded"]>>[0],
		) => Promise<void>;
		system?: SystemServices;
		workspaces?: SessionWorkspaceService;
	}) {
		this.sessions = options.sessions;
		this.runs = options.runs;
		this.profiles = options.profiles;
		this.runtimes = options.runtimes;
		this.capabilities = options.capabilities;
		this.onRecoveryError = options.onRecoveryError;
		this.getSandboxPolicy = options.getSandboxPolicy;
		this.memoryState = options.memoryState;
		this.onSkillLoaded = options.onSkillLoaded;
		this.system = options.system ?? defaultSystemServices;
		this.workspaces = options.workspaces;
	}

	async initializeRecovery(): Promise<void> {
		const now = toTimestamp(this.system.now());
		await this.runs.markRunningInterrupted(now);
		await this.sessions.markRunningInterrupted(now);
		for (const session of await this.sessions.list()) {
			if (!session.deletionRequestedAt) await this.workspaces?.ensure(session.id, session.projectId);
			if (!session.deletionRequestedAt) continue;
			try {
				await this.finishDeletion(session);
			} catch (error) {
				// A failed file validation has already restored a visible unavailable session.
				// Retain database cleanup failures for the next recovery attempt.
				if ((await this.sessions.get(session.id))?.deletionRequestedAt) throw error;
				await this.onRecoveryError?.(session.id, error);
			}
		}
	}

	async create(input: CreateWorkbenchSessionInput): Promise<WorkbenchSession> {
		const title = input.title === undefined ? "" : validateTitle(input.title);
		const runtime = this.requireRuntime(input.runtime ?? "pi");
		const kind = input.kind ?? (input.project ? "project" : "personal");
		if (kind === "project" && !input.project)
			throw new WorkbenchError("invalid_input", "Project sessions require a project");
		const workbenchSessionId = this.system.id();
		await this.workspaces?.ensure(workbenchSessionId, input.project?.id);
		const cwd =
			input.project?.sourcePath ??
			input.project?.workspacePath ??
			(typeof input.cwd === "function" ? input.cwd(workbenchSessionId) : input.cwd) ??
			process.cwd();
		const prepared = await this.prepareContext(input.profile, {
			workbenchSessionId,
			projectId: input.project?.id,
			cwd,
			context: input.context,
		});
		const runtimeSession = await runtime.createSession({
			cwd,
			kind,
			model: input.profile.defaultModel,
			context: prepared.context,
		});
		const now = toTimestamp(this.system.now());
		const session = await this.sessions.create({
			id: workbenchSessionId,
			runtime: runtime.id,
			runtimeSessionId: runtimeSession.id,
			runtimeRef: runtimeSession.reference.opaque,
			projectId: input.project?.id,
			agentProfileId: input.profile.id,
			title,
			kind,
			status: "idle",
			cwd,
			model: runtimeSession.model,
			thinkingLevel: runtimeSession.thinkingLevel,
			appliedProfileVersion: input.profile.version,
			configurationFingerprint: prepared.fingerprint,
			createdAt: now,
			updatedAt: now,
			lastActiveAt: now,
		});
		this.attachedSessionIds.add(session.id);
		return session;
	}

	async resume(
		id: string,
		context?: RuntimeContextOptions,
		selection?: ChatSelection,
		modelOverride?: RuntimeModelRef,
	): Promise<WorkbenchSession> {
		const session = await this.get(id);
		this.assertMutable(session);
		if (session.archivedAt) throw new WorkbenchError("conflict", "请先恢复已归档的会话");
		if (session.status === "running") throw new WorkbenchError("conflict", "Running sessions cannot be resumed");
		if (session.status === "closed") throw new WorkbenchError("conflict", "Closed sessions cannot be resumed");
		const runtime = this.requireRuntime(session.runtime);
		const profile = await this.profiles.get(session.agentProfileId);
		if (!profile) throw new WorkbenchError("not_found", `Agent profile not found: ${session.agentProfileId}`);
		const reference: RuntimeSessionReference = {
			runtime: session.runtime,
			runtimeSessionId: session.runtimeSessionId,
			opaque: session.runtimeRef,
		};
		try {
			const prepared = await this.prepareContext(profile, {
				workbenchSessionId: session.id,
				runtimeSessionId: session.runtimeSessionId,
				projectId: session.projectId,
				cwd: session.cwd,
				context,
				explicitSkillId: selection?.skillId,
			});
			if (this.attachedSessionIds.has(id)) {
				await runtime.releaseSession(session.runtimeSessionId);
				this.attachedSessionIds.delete(id);
			}
			const resumed = await runtime.resumeSession({
				model: modelOverride ?? session.modelOverride ?? profile.defaultModel,
				reference,
				expectedCwd: session.cwd,
				kind: session.kind,
				context: prepared.context,
			});
			const selectedModel = modelOverride ?? session.modelOverride ?? profile.defaultModel;
			if (selectedModel) {
				await runtime.selectModel(resumed.id, selectedModel);
				resumed.model = selectedModel;
			}
			if (session.thinkingLevel && runtime.selectThinkingLevel) {
				const model = (await runtime.listModels()).find(
					(item) => item.provider === resumed.model?.provider && item.modelId === resumed.model?.modelId,
				);
				if (model?.thinkingLevels?.includes(session.thinkingLevel))
					await runtime.selectThinkingLevel(resumed.id, session.thinkingLevel);
			}
			const actual = await runtime.getSession(resumed.id);
			const now = toTimestamp(this.system.now());
			const updated = await this.sessions.update({
				...(await this.get(id)),
				status: "idle",
				model: resumed.model,
				thinkingLevel: actual.thinkingLevel,
				appliedProfileVersion: profile.version,
				configurationFingerprint: prepared.fingerprint,
				updatedAt: now,
				lastActiveAt: now,
				unavailableReason: undefined,
			});
			this.attachedSessionIds.add(updated.id);
			return updated;
		} catch (error) {
			await this.sessions.update({
				...(await this.get(id)),
				status: "unavailable",
				updatedAt: toTimestamp(this.system.now()),
				unavailableReason: error instanceof Error ? error.message : String(error),
			});
			throw error;
		}
	}

	async *send(id: string, input: SendWorkbenchMessageInput): AsyncIterable<AgentEvent> {
		if (this.activeRuns.has(id) || this.preparingRuns.has(id))
			throw new WorkbenchError("conflict", "该会话正在准备或执行，其他会话可以并发运行");
		this.preparingRuns.add(id);
		try {
			let session = await this.get(id);
			this.assertMutable(session);
			if (session.archivedAt) throw new WorkbenchError("conflict", "请先恢复已归档的会话");
			const selectedProfile = await this.profiles.get(session.agentProfileId);
			if (!selectedProfile)
				throw new WorkbenchError("not_found", `Agent profile not found: ${session.agentProfileId}`);
			const prepared = await this.prepareContext(selectedProfile, {
				workbenchSessionId: session.id,
				runtimeSessionId: session.runtimeSessionId,
				projectId: session.projectId,
				cwd: session.cwd,
				context: input.context,
				explicitSkillId: input.selection?.skillId,
			});
			if (
				this.attachedSessionIds.has(id) &&
				(session.appliedProfileVersion !== selectedProfile.version ||
					session.configurationFingerprint !== prepared.fingerprint)
			) {
				if (session.status !== "idle")
					throw new WorkbenchError("conflict", "Assistant changes apply after the current run");
				await this.requireRuntime(session.runtime).releaseSession(session.runtimeSessionId);
				this.attachedSessionIds.delete(id);
			}
			if (!this.attachedSessionIds.has(id) || session.status === "interrupted" || session.status === "unavailable") {
				session = await this.resume(id, input.context, input.selection);
			}
			if (session.status !== "idle") throw new WorkbenchError("conflict", `Session is ${session.status}`);
			const profile = selectedProfile;
			const invocation = await this.prepareInvocation(id, input.text, input.selection);
			session = await this.get(id);
			if (!session.title) {
				const named = await this.sessions.updateTitle(
					id,
					provisionalSessionTitle(input.text),
					toTimestamp(this.system.now()),
					"",
				);
				session = named ?? (await this.get(id));
				if (named) this.generateTitle(named, input.text, this.requireRuntime(named.runtime));
			}
			this.assertMutable(session);
			if (session.archivedAt) throw new WorkbenchError("conflict", "请先恢复已归档的会话");
			const runId = input.runId ?? this.system.id();
			const now = toTimestamp(this.system.now());
			let run: AgentRun = {
				id: runId,
				sessionId: session.id,
				taskRunId: input.taskRunId,
				status: "running",
				inputMessageId: input.inputMessageId,
				profileSlug: profile.slug,
				profileVersion: profile.version,
				capabilities: {
					...this.capabilitySummary(prepared.resolved),
					requested: input.selection ?? {},
					thinkingLevel: session.thinkingLevel ?? null,
				},
				model: session.model,
				startedAt: now,
			};
			await this.runs.create(run);
			session = await this.sessions.updateRunStatus(id, "running", now);
			this.activeRuns.set(id, runId);
			const runtime = this.requireRuntime(session.runtime);
			let terminal = false;
			try {
				if (!isMinimalAssistant(profile)) {
					try {
						await this.memoryState?.begin(session, run, input.text);
					} catch (error) {
						await this.onRecoveryError?.(id, error);
					}
				}
				for await (const event of runtime.sendMessage(
					session.runtimeSessionId,
					{
						id: input.inputMessageId,
						text: invocation.text,
						images: input.images,
						attachments: input.attachments,
						attachmentText: input.attachmentText,
					},
					{
						runId,
						context: {
							getWorkingCheckpoint: prepared.context.getWorkingCheckpoint,
							onModelContext: prepared.context.onModelContext,
							onSkillLoaded: prepared.context.onSkillLoaded,
							appendSystemPrompt: [...(input.turnContext?.appendSystemPrompt ?? []), ...invocation.instructions],
							appendUserContext: isMinimalAssistant(profile) ? [] : input.turnContext?.appendUserContext,
						},
						signal: input.signal,
					},
				)) {
					if (!isMinimalAssistant(profile)) {
						try {
							await this.memoryState?.observe({ ...event, sessionId: id });
						} catch (error) {
							await this.onRecoveryError?.(id, error);
						}
					}
					yield { ...event, sessionId: id };
					if (event.type === "run.completed") {
						run = { ...run, status: "completed", finalMessageId: event.data.finalMessageId };
						terminal = true;
					} else if (event.type === "run.aborted") {
						run = { ...run, status: "aborted" };
						terminal = true;
					} else if (event.type === "run.failed") {
						run = { ...run, status: "failed", errorCode: event.data.code, errorMessage: event.data.message };
						terminal = true;
					}
				}
			} catch (error) {
				run = { ...run, status: "failed", errorMessage: error instanceof Error ? error.message : String(error) };
				throw error;
			} finally {
				const settledAt = toTimestamp(this.system.now());
				if (!terminal && run.status === "running") run = { ...run, status: "interrupted" };
				await this.runs.update({ ...run, settledAt });
				if (!isMinimalAssistant(profile)) {
					try {
						await this.memoryState?.settle(session, { ...run, settledAt });
					} catch (error) {
						await this.onRecoveryError?.(id, error);
					}
				}
				await this.sessions.updateRunStatus(id, run.status === "interrupted" ? "interrupted" : "idle", settledAt);
				this.activeRuns.delete(id);
			}
		} finally {
			this.activeRuns.delete(id);
			this.preparingRuns.delete(id);
		}
	}

	async steer(id: string, input: { text: string; runId: string }): Promise<void> {
		const text = input.text.trim();
		if (!text) throw new WorkbenchError("invalid_input", "追加指令不能为空");
		const session = await this.get(id);
		this.assertMutable(session);
		if (session.archivedAt || session.status !== "running" || this.activeRuns.get(id) !== input.runId)
			throw new WorkbenchError("conflict", "当前任务已结束或已切换，请确认任务状态后再发送");
		const runtime = this.requireRuntime(session.runtime);
		if (!runtime.getCapabilities().steering || !runtime.steerMessage)
			throw new WorkbenchError("invalid_input", "当前运行时不支持追加指令");
		await runtime.steerMessage(session.runtimeSessionId, text, input.runId);
	}

	async abort(id: string): Promise<void> {
		const session = await this.get(id);
		if (!this.attachedSessionIds.has(id)) throw new WorkbenchError("conflict", "Session has no active runtime");
		await this.requireRuntime(session.runtime).abort(session.runtimeSessionId);
	}

	async readInputQueue(id: string): Promise<RuntimeInputQueue> {
		const session = await this.get(id);
		if (!this.attachedSessionIds.has(id)) return { revision: 0, steering: [], followUp: [] };
		return (
			this.requireRuntime(session.runtime).readInputQueue?.(session.runtimeSessionId) ?? {
				revision: 0,
				steering: [],
				followUp: [],
			}
		);
	}

	async updateInputQueue(
		id: string,
		input: { runId: string; text: string } | { runId: string; itemId: string; action: RuntimeQueueAction },
	): Promise<RuntimeInputQueue> {
		const text = "text" in input ? input.text : input.action.kind === "edit" ? input.action.text : undefined;
		if (text !== undefined && !text.trim()) throw new WorkbenchError("invalid_input", "排队消息不能为空");
		const session = await this.get(id);
		this.assertMutable(session);
		if (session.archivedAt || session.status !== "running" || this.activeRuns.get(id) !== input.runId)
			throw new WorkbenchError("conflict", "当前任务已结束或已切换，请重新发送消息");
		const runtime = this.requireRuntime(session.runtime);
		if (!runtime.queueMessage || !runtime.updateQueuedMessage)
			throw new WorkbenchError("invalid_input", "当前运行时不支持消息排队");
		return "text" in input
			? runtime.queueMessage(session.runtimeSessionId, input.text, input.runId)
			: runtime.updateQueuedMessage(session.runtimeSessionId, input.itemId, input.action, input.runId);
	}

	async close(id: string): Promise<WorkbenchSession> {
		if (this.preparingRuns.has(id)) throw new WorkbenchError("conflict", "请先停止会话，再关闭");
		const session = await this.get(id);
		if (session.status === "running") throw new WorkbenchError("conflict", "Running sessions cannot be closed");
		const runtime = this.requireRuntime(session.runtime);
		if (this.attachedSessionIds.has(id)) await runtime.releaseSession(session.runtimeSessionId);
		this.attachedSessionIds.delete(id);
		const now = toTimestamp(this.system.now());
		return this.sessions.update({ ...(await this.get(id)), status: "closed", updatedAt: now, closedAt: now });
	}

	async get(id: string): Promise<WorkbenchSession> {
		const session = await this.sessions.get(id);
		if (!session || session.deletionRequestedAt) throw new WorkbenchError("not_found", `Session not found: ${id}`);
		return session;
	}

	async list(projectId?: string, includeArchived = false): Promise<WorkbenchSession[]> {
		return (await this.sessions.list(projectId)).filter(
			(session) => !session.deletionRequestedAt && (includeArchived || !session.archivedAt),
		);
	}

	async rename(id: string, title: string, expectedTitle?: string): Promise<WorkbenchSession> {
		const name = validateTitle(title);
		if (this.sessionMutations.has(id)) throw new WorkbenchError("conflict", "会话正在更新，请稍后再试");
		await this.get(id);
		const updated = await this.sessions.updateTitle(id, name, toTimestamp(this.system.now()), expectedTitle);
		if (!updated) throw new WorkbenchError("conflict", "会话名称已被修改，请刷新后再试");
		this.pendingTitles.get(id)?.controller.abort();
		return updated;
	}

	private generateTitle(session: WorkbenchSession, prompt: string, runtime: AgentRuntime): void {
		if (!runtime.generateSessionTitle || this.pendingTitles.has(session.id)) return;
		const controller = new AbortController();
		const signal = controller.signal;
		const timeout = setTimeout(() => controller.abort(), 30_000);
		let onAbort: () => void = () => undefined;
		const cancelled = new Promise<undefined>((resolve) => {
			onAbort = () => resolve(undefined);
			signal.addEventListener("abort", onAbort, { once: true });
		});
		const completion = Promise.resolve().then(async () => {
			try {
				if (signal.aborted) return;
				const title = await Promise.race([
					runtime.generateSessionTitle!(session.runtimeSessionId, prompt, signal),
					cancelled,
				]);
				if (!title || signal.aborted) return;
				await this.sessions.updateTitle(
					session.id,
					validateTitle(title),
					toTimestamp(this.system.now()),
					session.title,
				);
			} catch {
				// Metadata failure leaves the provisional name; it never interrupts the user's run.
			} finally {
				clearTimeout(timeout);
				signal.removeEventListener("abort", onAbort);
				this.pendingTitles.delete(session.id);
			}
		});
		this.pendingTitles.set(session.id, { controller, completion });
	}

	async dispose(): Promise<void> {
		const pending = [...this.pendingTitles.values()];
		for (const title of pending) title.controller.abort();
		await Promise.all(pending.map((title) => title.completion));
	}

	async archive(id: string, archived: boolean): Promise<WorkbenchSession> {
		if (this.sessionMutations.has(id) || this.preparingRuns.has(id))
			throw new WorkbenchError("conflict", "会话正在运行或更新，请稍后再试");
		this.sessionMutations.add(id);
		try {
			const session = await this.get(id);
			if (session.status === "running" || this.activeRuns.has(id))
				throw new WorkbenchError("conflict", "请先停止会话，再归档或恢复");
			if (archived && this.attachedSessionIds.has(id)) {
				await this.requireRuntime(session.runtime).releaseSession(session.runtimeSessionId);
				this.attachedSessionIds.delete(id);
			}
			const now = toTimestamp(this.system.now());
			return await this.sessions.update({
				...(await this.get(id)),
				archivedAt: archived ? now : undefined,
				updatedAt: now,
			});
		} finally {
			this.sessionMutations.delete(id);
		}
	}

	async delete(id: string): Promise<void> {
		if (this.sessionMutations.has(id) || this.preparingRuns.has(id))
			throw new WorkbenchError("conflict", "会话正在运行或更新，请稍后再试");
		this.sessionMutations.add(id);
		try {
			const session = await this.sessions.get(id);
			if (!session) return;
			if (session.status === "running" || this.activeRuns.has(id))
				throw new WorkbenchError("conflict", "请先停止会话，再删除");
			const pending = await this.sessions.update({
				...session,
				deletionRequestedAt: session.deletionRequestedAt ?? toTimestamp(this.system.now()),
			});
			this.pendingTitles.get(id)?.controller.abort();
			await this.finishDeletion(pending);
		} finally {
			this.sessionMutations.delete(id);
		}
	}

	private async finishDeletion(session: WorkbenchSession): Promise<void> {
		const disposition = await this.workspaces?.validateDeletion(session).catch(async (error: unknown) => {
			await this.sessions.update({ ...session, deletionRequestedAt: undefined });
			throw error;
		});
		try {
			await this.requireRuntime(session.runtime).deleteSessionReference({
				reference: {
					runtime: session.runtime,
					runtimeSessionId: session.runtimeSessionId,
					opaque: session.runtimeRef,
				},
				expectedCwd: session.cwd,
				kind: session.kind,
			});
		} catch (error) {
			await this.sessions.update({
				...session,
				deletionRequestedAt: undefined,
				status: "unavailable",
				unavailableReason: error instanceof Error ? error.message : String(error),
			});
			throw error;
		}
		this.attachedSessionIds.delete(session.id);
		await this.workspaces?.finishDeletion(session, disposition);
		await this.sessions.delete(session.id);
	}

	private assertMutable(session: WorkbenchSession): void {
		if (this.sessionMutations.has(session.id)) throw new WorkbenchError("conflict", "会话正在更新，请稍后再试");
	}

	async chatCapabilities(projectId?: string): Promise<ChatCapabilityCatalog> {
		const skills = (await this.capabilities?.invocableSkills(projectId)) ?? [];
		return {
			items: [
				...skills.map((skill) => ({
					id: skill.id,
					kind: "skill" as const,
					name: skill.name,
					label: `${skill.name}${skill.scope === "project" ? " · 项目" : ""}`,
					description: skill.description,
				})),
			],
			diagnostics: [],
		};
	}

	async prepareInvocation(
		id: string,
		text: string,
		selection?: ChatSelection,
	): Promise<{ text: string; instructions: string[] }> {
		const session = await this.get(id);
		if (session.archivedAt || session.status === "closed")
			throw new WorkbenchError("conflict", "请先恢复会话再发送消息");
		if (!selection?.skillId) return { text, instructions: [] };
		const profile = await this.profiles.get(session.agentProfileId);
		if (profile && isMinimalAssistant(profile))
			throw new WorkbenchError("invalid_input", "极简助手仅使用持久终端，不加载技能；请选择标准助手或 PTC 助手。");
		const catalog = await this.chatCapabilities(session.projectId);
		const skill = selection.skillId
			? catalog.items.find((item) => item.kind === "skill" && item.id === selection.skillId)
			: undefined;
		if (selection.skillId && !skill)
			throw new WorkbenchError("invalid_input", "选择的技能已停用、无效或不属于当前项目，请重新选择");
		return {
			text: skill ? `/skill:${skill.name} ${text}` : text,
			instructions: [],
		};
	}

	async readTranscript(id: string, _context?: RuntimeContextOptions): Promise<RuntimeTranscriptMessage[]> {
		const session = await this.get(id);
		const runtime = this.requireRuntime(session.runtime);
		if (this.attachedSessionIds.has(id)) return runtime.readTranscript(session.runtimeSessionId);
		return runtime.readTranscriptReference({
			reference: {
				runtime: session.runtime,
				runtimeSessionId: session.runtimeSessionId,
				opaque: session.runtimeRef,
			},
			expectedCwd: session.cwd,
			kind: session.kind,
		});
	}

	async readDevelopmentState(id: string): Promise<DevelopmentState | undefined> {
		const session = await this.get(id);
		return this.requireRuntime(session.runtime).readDevelopmentState?.({
			reference: {
				runtime: session.runtime,
				runtimeSessionId: session.runtimeSessionId,
				opaque: session.runtimeRef,
			},
			expectedCwd: session.cwd,
			kind: session.kind,
		});
	}

	async readUsage(id: string) {
		const session = await this.get(id);
		return this.requireRuntime(session.runtime).readUsage?.({
			reference: {
				runtime: session.runtime,
				runtimeSessionId: session.runtimeSessionId,
				opaque: session.runtimeRef,
			},
			expectedCwd: session.cwd,
			kind: session.kind,
			model: session.model,
		});
	}

	listModels(runtimeId = "pi"): Promise<RuntimeModel[]> {
		return this.requireRuntime(runtimeId).listModels();
	}

	async executeCommand(
		id: string,
		command: RuntimeSessionCommand,
		context?: RuntimeContextOptions,
		signal?: AbortSignal,
	) {
		let session = await this.get(id);
		this.assertMutable(session);
		if (
			this.preparingRuns.has(id) ||
			session.status === "running" ||
			session.archivedAt ||
			session.status === "closed"
		)
			throw new WorkbenchError("conflict", "请在会话空闲且未归档时执行命令");
		const runtime = this.requireRuntime(session.runtime);
		if (!runtime.executeSessionCommand) throw new WorkbenchError("invalid_input", "当前运行时不支持会话命令");
		this.preparingRuns.add(id);
		try {
			if (!this.attachedSessionIds.has(id)) session = await this.resume(id, context);
			const result = await runtime.executeSessionCommand(session.runtimeSessionId, command, signal);
			if (command.name === "compact")
				await this.sessions.update({
					...(await this.get(id)),
					updatedAt: toTimestamp(this.system.now()),
					lastActiveAt: toTimestamp(this.system.now()),
				});
			return result;
		} finally {
			this.preparingRuns.delete(id);
		}
	}

	async selectModel(id: string, model: RuntimeModelRef, context?: RuntimeContextOptions): Promise<WorkbenchSession> {
		let session = await this.get(id);
		this.assertMutable(session);
		if (this.preparingRuns.has(id) || session.archivedAt)
			throw new WorkbenchError("conflict", "会话正在准备运行或已归档");
		if (session.status === "running") throw new WorkbenchError("conflict", "Model cannot change during a run");
		const runtime = this.requireRuntime(session.runtime);
		if (
			!(await runtime.listModels()).some(
				(entry) => entry.provider === model.provider && entry.modelId === model.modelId && entry.available,
			)
		)
			throw new WorkbenchError("invalid_input", "该模型尚未添加、已停用或没有可用凭证，请在设置中检查");
		if (!this.attachedSessionIds.has(id)) session = await this.resume(id, context, undefined, model);
		await this.requireRuntime(session.runtime).selectModel(session.runtimeSessionId, model);
		const actual = await this.requireRuntime(session.runtime).getSession(session.runtimeSessionId);
		const now = toTimestamp(this.system.now());
		return this.sessions.update({
			...(await this.get(id)),
			model,
			thinkingLevel: actual.thinkingLevel,
			modelOverride: model,
			updatedAt: now,
			lastActiveAt: now,
		});
	}

	async selectProfile(id: string, profileId: string, expectedProfileId: string): Promise<WorkbenchSession> {
		if (this.sessionMutations.has(id) || this.preparingRuns.has(id))
			throw new WorkbenchError("conflict", "会话正在运行或更新，请稍后再试");
		this.sessionMutations.add(id);
		try {
			const session = await this.get(id);
			if (
				session.status === "running" ||
				this.activeRuns.has(id) ||
				session.archivedAt ||
				session.status === "closed"
			)
				throw new WorkbenchError("conflict", "请在会话空闲且未归档时切换助手");
			if (session.agentProfileId !== expectedProfileId)
				throw new WorkbenchError("conflict", "会话助手已被修改，请刷新后再试");
			const profile = await this.profiles.get(profileId);
			if (!profile || profile.deletedAt || profile.status !== "active")
				throw new WorkbenchError("invalid_input", "请选择可用的助手");
			if (this.attachedSessionIds.has(id)) {
				await this.requireRuntime(session.runtime).releaseSession(session.runtimeSessionId);
				this.attachedSessionIds.delete(id);
			}
			return await this.sessions.update({
				...(await this.get(id)),
				agentProfileId: profile.id,
				configurationFingerprint: undefined,
				appliedProfileVersion: undefined,
				updatedAt: toTimestamp(this.system.now()),
			});
		} finally {
			this.sessionMutations.delete(id);
		}
	}

	async selectThinkingLevel(
		id: string,
		level: RuntimeThinkingLevel,
		context?: RuntimeContextOptions,
	): Promise<WorkbenchSession> {
		let session = await this.get(id);
		this.assertMutable(session);
		if (this.preparingRuns.has(id) || session.status === "running" || session.archivedAt)
			throw new WorkbenchError("conflict", "请在会话空闲且未归档时修改思考强度");
		if (!this.attachedSessionIds.has(id)) session = await this.resume(id, context);
		const runtime = this.requireRuntime(session.runtime);
		if (!runtime.selectThinkingLevel) throw new WorkbenchError("invalid_input", "当前运行时不支持思考强度选择");
		const model = (await runtime.listModels()).find(
			(entry) => entry.provider === session.model?.provider && entry.modelId === session.model?.modelId,
		);
		if (!model?.thinkingLevels?.includes(level))
			throw new WorkbenchError("invalid_input", "当前模型不支持所选思考强度");
		const actual = await runtime.selectThinkingLevel(session.runtimeSessionId, level);
		return this.sessions.update({
			...(await this.get(id)),
			thinkingLevel: actual,
			updatedAt: toTimestamp(this.system.now()),
		});
	}

	getActiveRunId(sessionId: string): string | undefined {
		return this.activeRuns.get(sessionId);
	}

	private requireRuntime(id: string): AgentRuntime {
		const runtime = this.runtimes.get(id);
		if (!runtime) throw new WorkbenchError("not_found", `Runtime not configured: ${id}`);
		return runtime;
	}

	private async prepareContext(
		profile: AgentProfile,
		input: {
			workbenchSessionId: string;
			runtimeSessionId?: string;
			projectId?: string;
			cwd: string;
			context?: RuntimeContextOptions;
			explicitSkillId?: string;
		},
	): Promise<{ context: RuntimeContextOptions; fingerprint: string; resolved?: ResolvedCapabilities }> {
		const minimal = isMinimalAssistant(profile);
		const sandbox = (await this.getSandboxPolicy?.()) ?? input.context?.sandbox;
		if (minimal && input.explicitSkillId) throw new WorkbenchError("invalid_input", "极简助手不加载技能");
		const resolved = await this.capabilities?.resolveForSession(
			profile,
			input.projectId ? { id: input.projectId } : undefined,
			input.explicitSkillId,
		);
		if (profile.status === "archived")
			throw new WorkbenchError("conflict", "This assistant is archived. Restore it before starting a new run.");
		if (resolved) this.capabilities?.assertUsable(resolved);
		const fingerprint =
			resolved && this.capabilities
				? this.capabilities.fingerprint({
						capabilities: resolved.fingerprint,
						instructions: minimal ? [] : input.context?.appendSystemPrompt,
						skillPaths: minimal ? [] : input.context?.skillPaths,
						sandbox,
					})
				: `${profile.id}:${profile.version}:${input.projectId ?? "personal"}:${JSON.stringify(sandbox)}`;
		return {
			resolved,
			fingerprint,
			context: {
				onModelContext: minimal ? undefined : input.context?.onModelContext,
				onSkillLoaded: minimal
					? undefined
					: (input.context?.onSkillLoaded ??
						(this.onSkillLoaded ? (value) => this.onSkillLoaded!(input.workbenchSessionId, value) : undefined)),
				getWorkingCheckpoint:
					!minimal && input.context?.getWorkingCheckpoint
						? input.context.getWorkingCheckpoint
						: !minimal && this.memoryState
							? async () => {
									const checkpoint = await this.memoryState!.checkpoint(input.workbenchSessionId);
									return checkpoint ? renderWorkingCheckpoint(checkpoint) : undefined;
								}
							: undefined,
				sandbox,
				minimal,
				systemPrompt: profile.systemPrompt,
				appendSystemPrompt: minimal
					? []
					: [
							...(input.context?.appendSystemPrompt ?? []),
							...(this.workspaces
								? [
										`当前会话独立工作区：${(await this.workspaces.describe(input.workbenchSessionId)).path}。会话资料可保存在此；项目源码仍在项目工作目录。删除会话时可保留、迁移或删除此独立目录。`,
									]
								: []),
						],
				skillPaths: minimal
					? []
					: resolved
						? resolved.skills
								.filter(
									(skill) =>
										!input.context?.skillPaths ||
										input.context.skillPaths.includes(skill.path) ||
										skill.id === input.explicitSkillId,
								)
								.map((skill) => skill.path)
						: input.context?.skillPaths,
				toolNames: resolved?.builtinToolNames ?? [...profile.tools, ...(input.context?.toolNames ?? [])],
				toolBindings: resolved?.toolBindings,
				toolScope: {
					workbenchSessionId: input.workbenchSessionId,
					runtimeSessionId: input.runtimeSessionId,
					assistantId: profile.id,
					assistantVersion: profile.version,
					projectId: input.projectId,
					cwd: input.cwd,
				},
			},
		};
	}

	private capabilitySummary(resolved?: ResolvedCapabilities) {
		if (!resolved) return undefined;
		return {
			builtinTools: resolved.builtinToolNames,
			skillIds: resolved.skills.map((skill) => skill.id),
			externalTools: resolved.toolBindings.map((binding) => binding.descriptor.id),
			fingerprint: resolved.fingerprint,
		};
	}
}

function validateTitle(value: string): string {
	const title = value.trim();
	if (!title || title.length > 200 || /[\r\n\u0000-\u001f]/u.test(title))
		throw new WorkbenchError("invalid_input", "会话名称须为 1–200 个字符，且不能包含换行或控制字符");
	return title;
}

/** A temporary preview while the isolated semantic title request is pending, also retained on failure. */
function provisionalSessionTitle(text: string): string {
	const firstLine =
		text
			.split(/\r?\n/u)
			.map((line) => line.trim())
			.find(Boolean) ?? "";
	const cleaned = firstLine
		.replace(/^\s*(?:#{1,6}\s+|[-*+]\s+|\d+[、.)]\s*)/u, "")
		.replace(/[\u0000-\u001f\u007f]/gu, " ")
		.replace(/\s+/gu, " ")
		.trim();
	const sentence = cleaned.match(/^.*?[。！？](?=\s|$)/u)?.[0] ?? cleaned;
	const characters = Array.from(sentence);
	return characters.length > 40 ? `${characters.slice(0, 39).join("")}…` : sentence || "对话";
}
