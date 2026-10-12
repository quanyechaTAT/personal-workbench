import { randomUUID } from "node:crypto";
import { lstat, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
	ActivityService,
	type AgentProfile,
	AgentProfileService,
	ArtifactService,
	AssistantDraftService,
	CapabilityService,
	CheckpointReviewService,
	type CreateProjectInput,
	isMinimalAssistant,
	type KnowledgeSearchResult,
	McpConnectionService,
	type MemoryContextFragment,
	MemoryService,
	MemoryStateService,
	ModelSettingsService,
	PathPolicy,
	PermissionService,
	type Project,
	ProjectLearningService,
	ProjectService,
	RunCoordinator,
	renderWorkingCheckpoint,
	SemanticMemoryService,
	SessionService,
	SettingsService,
	SkillImportService,
	SkillService,
	type TaskRun,
	TaskService,
	WebSearchService,
	WorkbenchError,
	WorkbenchPaths,
	type WorkbenchSession,
	WorkspaceManager,
} from "@earendil-works/workbench-core";
import {
	createWorkbenchRepositories,
	WorkbenchDatabase,
	type WorkbenchRepositories,
} from "@earendil-works/workbench-database";
import { McpConnectionManager, McpOAuthCoordinator, McpTransportFactory } from "@earendil-works/workbench-mcp";
import type {
	AgentRuntime,
	RuntimeContextOptions,
	RuntimeModelRef,
	RuntimeSandboxPolicy,
	RuntimeThinkingLevel,
} from "@earendil-works/workbench-runtime";
import {
	createWorkbenchExtension,
	PiRuntime,
	type PiRuntimeOptions,
	PiSkillCatalog,
} from "@earendil-works/workbench-runtime-pi";
import { AuthorizedToolProvider } from "./authorized-tool-provider.ts";
import { BrowserUseService } from "./browser-use.ts";
import { installBuiltinSkills, isBuiltinSkill } from "./builtin-skills.ts";
import { ComputerUseService } from "./computer-use.ts";
import { type BuiltSessionContext, SessionContextBuilder } from "./context-builder.ts";
import { DiagnosticEventStore } from "./diagnostics.ts";
import { AgentEventBroker } from "./event-broker.ts";
import { FileService } from "./file-service.ts";
import { WorkbenchInstanceLock } from "./instance-lock.ts";
import { KnowledgeEmbeddingClient } from "./knowledge-embedding.ts";
import { necessaryQueryContext } from "./knowledge-mqe.ts";
import { KnowledgeService } from "./knowledge-service.ts";
import { StructuredLogger } from "./logger.ts";
import { MemoryEmbeddingScope } from "./memory-embedding.ts";
import { MAX_MEMORY_CONTEXT_CHARACTERS, MemoryRetrievalService, renderMemoryContext } from "./memory-retrieval.ts";
import { ProjectDeletionService } from "./project-deletion-service.ts";
import { SecretStore } from "./secret-store.ts";
import { minimalShellEnvironment } from "./shell-environment.ts";
import { WorkbenchSkillSourceStager } from "./skill-sources/source-stager.ts";
import type { SystemFolderReader } from "./system-folders.ts";
import { TaskCleanupService } from "./task-cleanup.ts";

export interface WorkbenchApplicationOptions {
	dataRoot?: string;
	agentDir?: string;
	runtime?: AgentRuntime;
	pi?: Pick<PiRuntimeOptions, "defaultModel" | "modelRuntime">;
	systemFolders?: SystemFolderReader;
	embeddingEnvFile?: string;
}

export interface WorkbenchServices {
	browserUse: BrowserUseService;
	computerUse: ComputerUseService;
	activity: ActivityService;
	profiles: AgentProfileService;
	capabilities: CapabilityService;
	connections: McpConnectionService;
	assistantDrafts: AssistantDraftService;
	projects: ProjectService;
	projectDeletion: ProjectDeletionService;
	learning: ProjectLearningService;
	tasks: TaskService;
	memory: MemoryService;
	memoryState: MemoryStateService;
	semantic: SemanticMemoryService;
	retrieval: MemoryRetrievalService;
	checkpointReview: CheckpointReviewService;
	knowledge: KnowledgeService;
	artifacts: ArtifactService;
	settings: SettingsService;
	modelSettings: ModelSettingsService;
	webSearch: WebSearchService;
	skills: SkillService;
	skillImports: SkillImportService;
	permissions: PermissionService;
	sessions: SessionService;
	files: FileService;
	taskCleanup: TaskCleanupService;
}

type CleanupStep = () => void | Promise<void>;

async function runCleanupSteps(steps: CleanupStep[]): Promise<unknown[]> {
	const errors: unknown[] = [];
	for (const step of steps) {
		try {
			await step();
		} catch (error) {
			errors.push(error);
		}
	}
	return errors;
}

export class WorkbenchApplication {
	readonly paths: WorkbenchPaths;
	readonly repositories: WorkbenchRepositories;
	readonly services: WorkbenchServices;
	readonly runtime: AgentRuntime;
	readonly events: AgentEventBroker;
	readonly context: SessionContextBuilder;
	readonly logger: StructuredLogger;
	readonly diagnostics: DiagnosticEventStore;
	readonly oauth: McpOAuthCoordinator;
	readonly secrets: SecretStore;
	private readonly database: WorkbenchDatabase;
	private readonly instanceLock: WorkbenchInstanceLock;
	private readonly mcp: McpConnectionManager;
	private readonly coordinator: RunCoordinator;
	private readonly sandboxProtectedPaths: string[];
	private closed = false;
	private readonly startingTasks = new Set<string>();
	private readonly pendingContexts = new Map<string, AbortController>();
	private readonly knowledgeTraces = new Map<string, KnowledgeSearchResult>();

	constructor(options: {
		paths: WorkbenchPaths;
		repositories: WorkbenchRepositories;
		services: WorkbenchServices;
		runtime: AgentRuntime;
		events: AgentEventBroker;
		context: SessionContextBuilder;
		logger: StructuredLogger;
		diagnostics: DiagnosticEventStore;
		oauth: McpOAuthCoordinator;
		secrets: SecretStore;
		mcp: McpConnectionManager;
		coordinator: RunCoordinator;
		database: WorkbenchDatabase;
		instanceLock: WorkbenchInstanceLock;
		sandboxProtectedPaths: string[];
	}) {
		this.paths = options.paths;
		this.repositories = options.repositories;
		this.services = options.services;
		this.runtime = options.runtime;
		this.events = options.events;
		this.context = options.context;
		this.logger = options.logger;
		this.diagnostics = options.diagnostics;
		this.oauth = options.oauth;
		this.secrets = options.secrets;
		this.mcp = options.mcp;
		this.coordinator = options.coordinator;
		this.database = options.database;
		this.instanceLock = options.instanceLock;
		this.sandboxProtectedPaths = options.sandboxProtectedPaths;
	}

	async contextForSession(id: string, query?: string, signal?: AbortSignal): Promise<BuiltSessionContext> {
		if (query && this.pendingContexts.has(id))
			throw new WorkbenchError("conflict", "会话正在准备检索上下文，请等待或停止后重试");
		const controller = query ? new AbortController() : undefined;
		if (controller) this.pendingContexts.set(id, controller);
		const combined = controller
			? signal
				? AbortSignal.any([signal, controller.signal])
				: controller.signal
			: signal;
		try {
			const session = await this.services.sessions.get(id);
			const profile = await this.services.profiles.get(session.agentProfileId);
			const project = session.projectId ? await this.services.projects.get(session.projectId) : undefined;
			if (project) await this.services.projects.assertSourceAvailable(project);
			await this.services.skills.discover("global");
			if (project) await this.services.skills.discover("project", project);
			const history = project && query ? await this.services.sessions.readTranscript(id) : [];
			const usage = await this.services.sessions.readUsage(id);
			const model = (await this.runtime.listModels()).find(
				(value) => value.provider === session.model?.provider && value.modelId === session.model?.modelId,
			);
			const memoryBudget = model
				? Math.min(
						MAX_MEMORY_CONTEXT_CHARACTERS,
						Math.max(
							0,
							Math.floor(
								(model.contextWindow -
									(usage?.contextTokens ?? 0) -
									model.maxTokens -
									Math.ceil((query?.length ?? 0) / 2) -
									1500) *
									3,
							),
						),
					)
				: MAX_MEMORY_CONTEXT_CHARACTERS;
			const context = await this.context.build(profile, project, query, {
				sessionId: id,
				budget: memoryBudget,
				signal: combined,
				context: query ? necessaryQueryContext(query, history) : [],
				model: session.model ?? profile.defaultModel,
			});
			const resolved = await this.services.capabilities.resolveForSession(profile, project);
			if (!isMinimalAssistant(profile) && context.memory) {
				context.runtime.getWorkingCheckpoint = async () => {
					const value = await this.services.memoryState.checkpoint(id);
					return value && (context.workingBudget ?? 0) >= 1000
						? renderWorkingCheckpoint(value, context.workingBudget)
						: undefined;
				};
				context.runtime.onModelContext = async (request) => {
					const checkpoint = await this.services.memoryState.checkpoint(id);
					const fragments = context.memory!.fragments.filter(
						(fragment) =>
							fragment.layer !== "working" &&
							fragment.layer !== "skill" &&
							(request.systemPrompt.includes(fragment.text) ||
								request.userContext?.some((text) => text.includes(fragment.text))),
					);
					if (request.workingCheckpoint && checkpoint)
						fragments.unshift({
							id: `working:${id}`,
							layer: "working",
							label: "本轮实际工作检查点",
							text: request.workingCheckpoint,
							version: checkpoint.version,
							reason: "Pi context 事件刷新并加入实际请求",
							sources: checkpoint.sources,
							truncated: JSON.stringify(checkpoint).length > (context.workingBudget ?? 4000),
						});
					for (const block of request.systemPrompt.matchAll(/<skill>[\s\S]*?<\/skill>/gu)) {
						const location = /<location>([\s\S]*?)<\/location>/u
							.exec(block[0])?.[1]
							?.replace(/&amp;/gu, "&")
							.replace(/&lt;/gu, "<")
							.replace(/&gt;/gu, ">")
							.replace(/&quot;/gu, '"')
							.replace(/&apos;/gu, "'");
						const known = context.memory!.fragments.find(
							(fragment) => fragment.layer === "skill" && fragment.sources[0]?.path === location,
						);
						if (known) fragments.push({ ...known, text: block[0], reason: "Pi SDK 实际加载的原生技能描述" });
					}
					const characters =
						renderMemoryContext(fragments).length +
						fragments
							.filter((value) => value.layer === "working" || value.layer === "skill")
							.reduce((sum, value) => sum + value.text.length, 0);
					await this.repositories.memoryState.saveContext({
						...context.memory!,
						fragments: fragments as MemoryContextFragment[],
						characters,
						estimatedTokens: Math.ceil(characters / 3),
						sessionId: id,
						projectId: session.projectId,
						runId: request.runId,
						request: request.request,
						createdAt: new Date().toISOString(),
						systemPromptCharacters: request.systemPrompt.length,
						loadedSkills: request.loadedSkills,
						baseSources: (context.runtime.appendSystemPrompt ?? []).map((text, index) => ({
							label: context.sources[index]?.label ?? `基础上下文 ${index + 1}`,
							text,
							characters: text.length,
						})),
					});
				};
				context.runtime.onSkillLoaded = (value) => this.services.learning.recordSkillLoad(id, value);
			}
			combined?.throwIfAborted();
			if (query && context.knowledge) {
				this.knowledgeTraces.delete(id);
				this.knowledgeTraces.set(id, context.knowledge);
				if (this.knowledgeTraces.size > 128)
					this.knowledgeTraces.delete(this.knowledgeTraces.keys().next().value ?? "");
			}
			return {
				...context,
				actualMemory: isMinimalAssistant(profile) ? undefined : await this.repositories.memoryState.getContext(id),
				knowledge: context.knowledge ?? (project ? this.knowledgeTraces.get(id) : undefined),
				runtime: {
					...context.runtime,
					sandbox: await this.sandboxPolicy(),
					toolNames: [
						...resolved.builtinToolNames,
						...resolved.toolBindings.map((binding) => binding.descriptor.label),
					],
				},
				assistant: {
					id: profile.id,
					name: profile.name,
					version: profile.version,
					appliedVersion: session.appliedProfileVersion,
				},
				diagnostics: [...(context.diagnostics ?? []), ...resolved.diagnostics],
			};
		} finally {
			if (controller && this.pendingContexts.get(id) === controller) this.pendingContexts.delete(id);
		}
	}
	stopContextPreparation(id: string): void {
		this.pendingContexts.get(id)?.abort();
	}

	async configure<T>(operation: (signal: AbortSignal) => Promise<T>, resourceKey?: string): Promise<T> {
		let result: { value: T } | undefined;
		const handle = this.coordinator.submit(
			`configuration-${randomUUID()}`,
			async (signal) => {
				result = { value: await operation(signal) };
			},
			{ queueIfBusy: false, resourceKey },
		);
		await handle.completion;
		if (!result) throw new WorkbenchError("conflict", "设置更新已取消");
		return result.value;
	}

	async createSession(input: {
		model?: RuntimeModelRef;
		thinkingLevel?: RuntimeThinkingLevel;
		profileId?: string;
		profileSlug?: string;
		projectId?: string;
		title?: string;
		kind?: WorkbenchSession["kind"];
	}): Promise<WorkbenchSession> {
		const project = input.projectId ? await this.services.projects.get(input.projectId) : undefined;
		if (project) await this.services.projects.assertSourceAvailable(project);
		const profile = await this.resolveProfile({
			...input,
			profileId: input.profileId ?? (!input.profileSlug ? project?.defaultProfileId : undefined),
		});
		if (profile.status !== "active")
			throw new WorkbenchError("conflict", "Archived assistants cannot create sessions");
		const context = await this.context.build(profile, project);
		context.runtime.sandbox = await this.sandboxPolicy();
		const configuredModel = await this.services.settings.get("models.default");
		const value = configuredModel?.value;
		const defaultModel =
			input.model ??
			profile.defaultModel ??
			(typeof value === "object" &&
			value !== null &&
			!Array.isArray(value) &&
			typeof value.provider === "string" &&
			typeof value.modelId === "string"
				? { provider: value.provider, modelId: value.modelId }
				: undefined);
		if (defaultModel || input.thinkingLevel) {
			const available = await this.runtime.listModels();
			const model = defaultModel
				? available.find(
						(entry) =>
							entry.provider === defaultModel.provider &&
							entry.modelId === defaultModel.modelId &&
							entry.available,
					)
				: available.find((entry) => entry.available);
			if (!model)
				throw new WorkbenchError("invalid_input", "默认模型尚未添加、已停用或没有可用凭证，请选择可用模型");
			if (input.thinkingLevel && !model.thinkingLevels?.includes(input.thinkingLevel))
				throw new WorkbenchError("invalid_input", "所选模型不支持该思考档位");
		}
		let session = await this.services.sessions.create({
			profile: { ...profile, defaultModel },
			project,
			cwd: (sessionId) => join(this.paths.workspace, "chats", sessionId),
			title: input.title,
			kind: input.kind,
			context: context.runtime,
		});
		if (input.model) session = await this.services.sessions.selectModel(session.id, input.model, context.runtime);
		if (input.thinkingLevel)
			session = await this.services.sessions.selectThinkingLevel(session.id, input.thinkingLevel, context.runtime);
		await this.services.activity.record({
			projectId: session.projectId,
			sessionId: session.id,
			type: "session.created",
			summary: `Created ${session.title}`,
		});
		return session;
	}

	async chatCapabilities(input: { sessionId?: string; profileId?: string; projectId?: string }) {
		const session = input.sessionId ? await this.services.sessions.get(input.sessionId) : undefined;
		const profile = await this.resolveProfile({ profileId: session?.agentProfileId ?? input.profileId });
		if (isMinimalAssistant(profile)) return { items: [], diagnostics: [] };
		const projectId = session ? session.projectId : input.projectId;
		const project = projectId ? await this.services.projects.get(projectId) : undefined;
		await this.services.skills.discover("global");
		if (project) await this.services.skills.discover("project", project);
		return this.services.sessions.chatCapabilities(projectId);
	}

	private async resolveProfile(input: { profileId?: string; profileSlug?: string }): Promise<AgentProfile> {
		const configuredMode =
			input.profileId || input.profileSlug ? undefined : await this.services.settings.get("agent.defaultProfileId");
		const legacyMode =
			input.profileId || input.profileSlug || configuredMode
				? undefined
				: await this.services.settings.get("agent.defaultMode");
		const profileSlug = input.profileSlug ?? (typeof legacyMode?.value === "string" ? legacyMode.value : "standard");
		const configuredProfileId = typeof configuredMode?.value === "string" ? configuredMode.value : undefined;
		const profile =
			input.profileId || configuredProfileId
				? await this.services.profiles.get(input.profileId ?? configuredProfileId!)
				: await this.services.profiles.getBySlug(profileSlug);
		return profile;
	}

	async createProject(input: CreateProjectInput): Promise<Project> {
		if (input.defaultProfileId) {
			const profile = await this.resolveProfile({ profileId: input.defaultProfileId });
			if (profile.status !== "active") throw new WorkbenchError("conflict", "请选择未归档的助手预设");
		}
		const project = await this.services.projects.create(input);
		await this.services.memory.reindex("project", `projects/${project.slug}/AGENTS.md`, project.id);
		await this.services.activity.record({
			projectId: project.id,
			type: "project.created",
			summary: `Created project ${project.name}`,
		});
		return project;
	}
	async deleteProject(id: string, expectedFingerprint: string) {
		if (this.pendingContexts.size || this.startingTasks.size)
			throw new WorkbenchError("conflict", "请等待会话上下文或任务启动完成后再删除项目");
		const result = await this.services.projectDeletion.delete(id, expectedFingerprint);
		for (const session of result.sessions) {
			this.events.forgetSession(session.id);
			this.diagnostics.forgetSession(session.id);
			this.diagnostics.forgetSession(session.runtimeSessionId);
			this.knowledgeTraces.delete(session.id);
		}
		return { deleted: result.deleted, projectId: result.projectId, compacted: result.compacted };
	}

	async startTask(
		id: string,
		input: { profileId?: string; profileSlug?: string; expectedVersion?: number } = {},
	): Promise<{
		taskRun: TaskRun;
		session: WorkbenchSession;
		runId: string;
	}> {
		if (this.startingTasks.has(id)) throw new WorkbenchError("conflict", "任务正在交给助手，请勿重复启动");
		this.startingTasks.add(id);
		try {
			const task = await this.services.tasks.assertRunnable(id, input.expectedVersion);
			const session = await this.configure(
				() =>
					this.createSession({
						projectId: task.projectId,
						profileId: input.profileId,
						profileSlug: input.profileSlug,
						kind: "background",
						title: `任务：${task.title}`,
					}),
				`session-create-task:${id}`,
			);
			let taskRun: TaskRun;
			try {
				taskRun = await this.services.tasks.queueAgentRun(task.id, session.id, {
					profileId: session.agentProfileId,
					expectedVersion: task.version,
				});
			} catch (error) {
				await this.services.sessions.delete(session.id);
				throw error;
			}
			try {
				const taskPrompt = `执行这项工作台任务。使用当前会话的工作目录，注册重要成果。开发改动必须运行检查并通过 accept_changes 验收，再汇报结果；未验收时任务会标为受阻，已验收后仍由用户确认完成。\n\n任务：${task.title}\n任务 ID：${task.id}\n\n${task.description}`;
				const context = await this.contextForSession(session.id, taskPrompt);
				const { runId } = this.events.start(session.id, {
					text: taskPrompt,
					taskRunId: taskRun.id,
					context: context.runtime,
					turnContext: context.turn,
					queueIfBusy: true,
					onStart: async (agentRunId) => {
						await this.services.tasks.beginAgentRun(taskRun.id, agentRunId);
						await this.services.activity.record({
							projectId: task.projectId,
							sessionId: session.id,
							runId: agentRunId,
							type: "task.started",
							summary: `Started agent task ${task.title}`,
							metadata: { taskId: task.id, taskRunId: taskRun.id },
						});
					},
					onEvent: async (event) => {
						if (event.type === "run.completed") {
							const acceptance = event.data.acceptance;
							const verificationRequired = Boolean(
								acceptance && acceptance.status !== "not_required" && acceptance.status !== "accepted",
							);
							await this.services.tasks.settleAgentRun(taskRun.id, "review", {
								agentRunId: event.runId,
								verificationRequired,
								errorCode: verificationRequired ? "verification_required" : undefined,
								summary: verificationRequired
									? `本轮结束，开发工作未验收：${acceptance!.reason}`
									: acceptance?.status === "accepted"
										? "开发验收已通过，等待用户确认完成"
										: "本轮结束，等待用户确认结果",
							});
						} else if (event.type === "run.failed") {
							await this.services.tasks.settleAgentRun(taskRun.id, "failed", {
								agentRunId: event.runId,
								errorCode: event.data.code,
								summary: event.data.message,
							});
						} else if (event.type === "run.aborted") {
							await this.services.tasks.settleAgentRun(taskRun.id, "cancelled", {
								agentRunId: event.runId,
								summary: event.data.reason ?? "Agent run stopped",
							});
						}
					},
				});
				return { taskRun, session, runId };
			} catch (error) {
				await this.services.tasks.settleAgentRun(taskRun.id, "failed", {
					summary: error instanceof Error ? error.message : String(error),
				});
				await this.services.sessions.delete(session.id);
				throw error;
			}
		} finally {
			this.startingTasks.delete(id);
		}
	}

	async resolveContext(profile: AgentProfile, project?: Project): Promise<RuntimeContextOptions> {
		return { ...(await this.context.build(profile, project)).runtime, sandbox: await this.sandboxPolicy() };
	}

	private async sandboxPolicy(): Promise<RuntimeSandboxPolicy> {
		return this.services.settings.sandboxPolicy(this.sandboxProtectedPaths);
	}

	async disconnectAuthorization(connectionId: string): Promise<void> {
		const current = await this.services.connections.get(connectionId);
		await this.services.connections.update(connectionId, current, current.version);
		await this.oauth.disconnect(connectionId);
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		for (const controller of this.pendingContexts.values()) controller.abort();
		const errors = await runCleanupSteps([
			() => this.logger.log("runtime.stop"),
			() => this.services.learning.dispose(),
			() => this.services.checkpointReview.dispose(),
			() => this.coordinator.shutdown(),
			() => this.services.sessions.dispose(),
			() => this.services.permissions.dispose(),
			() => this.runtime.dispose(),
			() => this.services.browserUse.dispose(),
			() => this.services.computerUse.dispose(),
			() => this.mcp.dispose(),
			() => this.oauth.dispose(),
			() => this.services.knowledge.dispose(),
			() => this.logger.flush(),
			() => this.database.close(),
			() => this.instanceLock.release(),
		]);
		if (errors[0]) throw errors[0];
	}
}

export async function createWorkbenchApplication(
	options: WorkbenchApplicationOptions = {},
): Promise<WorkbenchApplication> {
	const paths = new WorkbenchPaths(resolve(options.dataRoot ?? join(homedir(), ".personal-workbench")));
	const workspace = new WorkspaceManager(paths);
	const instanceLock = await WorkbenchInstanceLock.acquire(join(paths.runtime, "workbench.lock"));
	let database: WorkbenchDatabase | undefined;
	let runtime: AgentRuntime | undefined;
	let permissions: PermissionService | undefined;
	let mcp: McpConnectionManager | undefined;
	let oauth: McpOAuthCoordinator | undefined;
	let knowledgeService: KnowledgeService | undefined;
	let browserUse: BrowserUseService | undefined;
	let computerUse: ComputerUseService | undefined;
	try {
		await workspace.initialize();
		const logger = new StructuredLogger(join(paths.logs, "workbench.jsonl"));
		await logger.initialize();
		await logger.log("runtime.start", { dataRoot: paths.root });
		const diagnostics = new DiagnosticEventStore();
		database = new WorkbenchDatabase(paths.database);
		const repositories = createWorkbenchRepositories(database);
		const activity = new ActivityService(repositories.activity);
		const secretStore = new SecretStore(paths.mcpSecretsFile);
		oauth = new McpOAuthCoordinator(repositories.mcpConnections, secretStore);
		const transports = new McpTransportFactory(secretStore, oauth);
		mcp = new McpConnectionManager(repositories.mcpConnections, transports);
		const pathPolicy = new PathPolicy(paths, [paths.credentials, resolve(options.agentDir ?? getAgentDir())]);
		const projects = new ProjectService(repositories.projects, workspace, undefined, pathPolicy);
		const tasks = new TaskService(repositories.tasks, undefined, repositories.taskRuns);
		const memory = new MemoryService(paths, pathPolicy, repositories.memory, undefined, repositories.semantic);
		const embeddingClient = new KnowledgeEmbeddingClient(options.embeddingEnvFile);
		const semantic = new SemanticMemoryService({
			paths,
			policy: pathPolicy,
			repository: repositories.semantic,
			memory,
			embedding: {
				fingerprint: () => new MemoryEmbeddingScope(embeddingClient).fingerprint(),
				embed: (text, signal) => new MemoryEmbeddingScope(embeddingClient).embed(text, signal),
			},
		});
		memory.attachSemantics(semantic);
		const generationModel = async (model?: RuntimeModelRef): Promise<RuntimeModelRef | undefined> => {
			if (model) return model;
			const saved = (await settings.get("models.default"))?.value;
			return saved &&
				typeof saved === "object" &&
				!Array.isArray(saved) &&
				typeof saved.provider === "string" &&
				typeof saved.modelId === "string"
				? { provider: saved.provider, modelId: saved.modelId }
				: undefined;
		};
		const knowledge = new KnowledgeService(repositories.knowledge, pathPolicy, {
			paths,
			embeddingEnvFile: options.embeddingEnvFile,
			onError: (message, documentId) => logger.log("knowledge.error", { message, documentId }),
			generateQueries: async (prompt, signal, model) =>
				runtime?.generateKnowledgeQueries?.(prompt, signal, await generationModel(model)),
			generateHypothesis: async (prompt, signal, model) =>
				runtime?.generateKnowledgeHypothesis?.(prompt, signal, await generationModel(model)),
		});
		knowledgeService = knowledge;
		const artifacts = new ArtifactService(paths, pathPolicy, repositories.artifacts);
		const settings = new SettingsService(repositories.settings);
		const skillCatalog = new PiSkillCatalog();
		const skills = new SkillService(paths, repositories.skills, skillCatalog);
		const skillImports = new SkillImportService({
			paths,
			imports: repositories.skillImports,
			skills: repositories.skills,
			projects: repositories.projects,
			catalog: skillCatalog,
			stager: new WorkbenchSkillSourceStager(join(paths.cache, "skill-imports")),
		});
		const permissionService = new PermissionService(repositories.approvals, undefined, settings);
		const browsers = new BrowserUseService();
		const desktop = new ComputerUseService(join(paths.cache, "desktop-tool"));
		browserUse = browsers;
		computerUse = desktop;
		permissions = permissionService;
		const authorizedTools = new AuthorizedToolProvider(mcp, repositories.mcpConnections, permissionService);
		let learning: ProjectLearningService | undefined;
		const projectSkills = async (projectId: string) => learning?.reusableSkills(projectId) ?? [];
		const capabilities = new CapabilityService(repositories.skills, repositories.mcpConnections, projectSkills);
		const profiles = new AgentProfileService(
			repositories.profiles,
			repositories.skills,
			repositories.mcpConnections,
			undefined,
			repositories.settings,
			async (model) =>
				(await runtime?.listModels())?.some(
					(candidate) =>
						candidate.available && candidate.provider === model.provider && candidate.modelId === model.modelId,
				) ?? false,
		);
		const connections = new McpConnectionService(repositories.mcpConnections, mcp);
		const files = new FileService(paths, pathPolicy);
		await Promise.all([permissionService.initialize(), projects.recoverCreating(), tasks.initializeRecovery()]);
		await installBuiltinSkills(paths);
		await skillImports.recoverPendingImports();
		for (const skill of await skills.discover("global")) {
			const builtin = isBuiltinSkill(skill.slug);
			await repositories.skills.upsert({
				...skill,
				isBuiltin: builtin,
				sourceKind: builtin ? "builtin" : skill.sourceKind,
			});
		}
		await profiles.ensureBuiltins();
		let memoryRetrieval: MemoryRetrievalService | undefined;
		const context = new SessionContextBuilder(
			paths,
			tasks,
			skills,
			memory,
			options.systemFolders,
			pathPolicy,
			knowledge,
			projectSkills,
			() => memoryRetrieval,
		);
		const coordinator = new RunCoordinator();
		let sessions: SessionService | undefined;
		let webSearch: WebSearchService;
		runtime =
			options.runtime ??
			(await PiRuntime.create({
				agentDir: resolve(options.agentDir ?? getAgentDir()),
				sessionDir: paths.piSessions,
				...options.pi,
				getCompactionPolicy: async () => {
					const [enabled, threshold] = await Promise.all([
						settings.get("context.autoCompactEnabled"),
						settings.get("context.autoCompactThresholdPercent"),
					]);
					return {
						enabled: enabled?.value !== false,
						thresholdPercent: typeof threshold?.value === "number" ? threshold.value : 80,
					};
				},
				toolProvider: authorizedTools,
				shellEnvironment: minimalShellEnvironment,
				onRawEvent: ({ sessionId, event }) => diagnostics.recordRaw(sessionId, event),
				sessionExtensionFactories: (extensionContext) => [
					createWorkbenchExtension({
						sandbox: extensionContext.sandbox,
						development: {
							onUpdate: extensionContext.emitDevelopmentEvent,
							powerShellOptions: {
								operations: extensionContext.powerShellOperations,
								exposeSessionEnvironment: false,
								spawnHook: (context) => ({ ...context, env: minimalShellEnvironment(context.env) }),
							},
						},
						services: {
							browserUse: browsers,
							computerUse: desktop,
							profiles,
							capabilities,
							webSearch: { search: (input, signal) => webSearch.search(input, signal) },
							projects,
							tasks,
							memory: {
								search: (scope, query, limit) => memory.search(scope, query, limit),
								propose: async (scope, input) => {
									const behavior = await settings.get("memory.candidateBehavior");
									if (behavior?.value === "disabled") {
										throw new WorkbenchError("conflict", "Agent memory proposals are disabled in Settings");
									}
									return memory.propose(scope, input);
								},
							},
							learning: {
								agentContext: async (sessionId, runId) => {
									if (!learning) throw new WorkbenchError("conflict", "经验服务尚未就绪");
									return learning.agentContext(sessionId, runId);
								},
								agentSkill: async (sessionId, runId, skillId) => {
									if (!learning) throw new WorkbenchError("conflict", "经验服务尚未就绪");
									return learning.agentSkill(sessionId, runId, skillId);
								},
								agentSave: async (sessionId, runId, toolCallId, input, signal) => {
									if (!learning || (await settings.get("memory.candidateBehavior"))?.value === "disabled")
										throw new WorkbenchError("conflict", "Agent 经验提炼已关闭");
									return learning.agentSave(sessionId, runId, toolCallId, input, signal);
								},
							},
							memoryRetrieval: async (sessionId, query, signal) => {
								if (!memoryRetrieval) throw new WorkbenchError("conflict", "记忆检索尚未就绪");
								return (await memoryRetrieval.retrieve({ sessionId, query, signal })).memory;
							},
							knowledge,
							artifacts,
							permissions: permissionService,
							pathPolicy,
						},
						resolveScope: async () => {
							const session = await repositories.sessions.getByRuntimeSession("pi", extensionContext.sessionId);
							if (!session)
								throw new Error(`Workbench session is missing for Pi session ${extensionContext.sessionId}`);
							return {
								project: session.projectId ? await repositories.projects.get(session.projectId) : undefined,
								sessionId: session.id,
								runId: sessions?.getActiveRunId(session.id),
							};
						},
						resolveToolSignal: extensionContext.getToolSignal,
						knowledgeContext: async (sessionId, query) =>
							necessaryQueryContext(query, (await sessions?.readTranscript(sessionId)) ?? []),
						onPermissionEvent: (event) => {
							extensionContext.emitPermissionEvent(event);
							void logger.log(
								event.type === "permission.requested" ? "permission.request" : "permission.resolve",
								event,
							);
						},
					}),
				],
			}));
		const activeRuntime = runtime;
		const modelSecrets = new SecretStore(join(paths.credentials, "models.json"));
		const modelSettings = new ModelSettingsService(settings, activeRuntime.modelCatalog, {
			create: (key) => modelSecrets.create({ bearerToken: key }),
			get: async (reference) => (await modelSecrets.getSecret(reference))?.bearerToken,
			delete: (reference) => modelSecrets.delete(reference),
		});
		const savedDefault = (await settings.get("models.default"))?.value;
		await modelSettings.initialize([
			...(await repositories.sessions.list()).flatMap((session) => (session.model ? [session.model] : [])),
			...(await profiles.list()).flatMap((profile) => (profile.defaultModel ? [profile.defaultModel] : [])),
			...(savedDefault &&
			typeof savedDefault === "object" &&
			!Array.isArray(savedDefault) &&
			typeof savedDefault.provider === "string" &&
			typeof savedDefault.modelId === "string"
				? [{ provider: savedDefault.provider, modelId: savedDefault.modelId }]
				: []),
			...(options.pi?.defaultModel
				? [{ provider: options.pi.defaultModel.provider, modelId: options.pi.defaultModel.id }]
				: []),
		]);
		webSearch = new WebSearchService(settings, activeRuntime.webSearch);
		if (!(await settings.get("search.builtinUpgrade"))) {
			for (const profile of await repositories.profiles.list()) {
				if (profile.isBuiltin && profile.slug !== "minimal" && !profile.tools.includes("web_search"))
					await repositories.profiles.upsert(
						{
							...profile,
							tools: [...profile.tools, "web_search"],
							version: profile.version + 1,
							updatedAt: new Date().toISOString(),
						},
						profile.version,
					);
			}
			await settings.set("search.builtinUpgrade", true);
		}
		if (!(await settings.get("knowledge.builtinUpgrade"))) {
			for (const profile of await repositories.profiles.list()) {
				if (profile.isBuiltin && profile.slug !== "minimal" && !profile.tools.includes("knowledge_search"))
					await repositories.profiles.upsert(
						{
							...profile,
							tools: [...profile.tools, "knowledge_search"],
							version: profile.version + 1,
							updatedAt: new Date().toISOString(),
						},
						profile.version,
					);
			}
			await settings.set("knowledge.builtinUpgrade", true);
		}
		const memoryState = new MemoryStateService({
			repository: repositories.memoryState,
			sessions: repositories.sessions,
			taskRuns: repositories.taskRuns,
			artifacts: repositories.artifacts,
			runtime: activeRuntime,
			embedding: {
				fingerprint: () => new MemoryEmbeddingScope(embeddingClient).fingerprint(),
				embed: (text, signal) => new MemoryEmbeddingScope(embeddingClient).embed(text, signal),
			},
		});
		await memoryState.initializeRecovery();
		memoryRetrieval = new MemoryRetrievalService({
			sessions: repositories.sessions,
			profiles: repositories.profiles,
			projects,
			memory,
			state: memoryState,
			semantic,
			knowledge,
		});
		sessions = new SessionService({
			sessions: repositories.sessions,
			runs: repositories.agentRuns,
			profiles: repositories.profiles,
			runtimes: new Map([[activeRuntime.id, activeRuntime]]),
			capabilities,
			memoryState,
			onSkillLoaded: async (sessionId, value) => {
				await learning?.recordSkillLoad(sessionId, value);
			},
			getSandboxPolicy: () =>
				settings.sandboxPolicy([
					paths.state,
					paths.config,
					paths.userMemory,
					resolve(options.agentDir ?? getAgentDir()),
				]),
			onRecoveryError: (sessionId, error) =>
				logger.log("error", {
					sessionId,
					operation: "session.delete.recovery",
					message: error instanceof Error ? error.message : String(error),
				}),
		});
		await sessions.initializeRecovery();
		const projectDeletion = new ProjectDeletionService({
			paths,
			projects: repositories.projects,
			sessionRepository: repositories.sessions,
			sessions,
			coordinator,
			logger,
			isBusy: async (id) => (await knowledge.isBusy(id)) || Boolean(await learning?.isBusy(id)),
			closeBrowser: (id) => browsers.closeSession(id),
			compact: () => database!.compact(),
		});
		await projectDeletion.recover();
		learning = new ProjectLearningService({
			repository: repositories.learning,
			projects,
			sessions,
			runs: repositories.agentRuns,
			profiles: repositories.profiles,
			settings,
			memory,
			skills,
			memoryState,
			stateRepository: repositories.memoryState,
			semantic,
			runtime: activeRuntime,
			paths,
			pathPolicy,
			coordinator,
			record: async (event, data) => {
				await logger.log(event, data);
				await activity.record({
					projectId: data.projectId,
					type: event,
					summary: data.summary ?? event,
					metadata: { reviewId: data.reviewId },
				});
			},
		});
		const projectLearning = learning;
		const checkpointReview = new CheckpointReviewService({
			state: memoryState,
			sessions,
			runs: repositories.agentRuns,
			profiles: repositories.profiles,
			settings,
			runtime: activeRuntime,
			coordinator,
			paths,
		});
		const assistantDrafts = new AssistantDraftService({
			repository: repositories.assistantDrafts,
			profiles,
			capabilities,
			runtime: activeRuntime,
			coordinator,
			cwd: paths.workspace,
			resolveDefaultModel: async () => {
				const configured = await settings.get("models.default");
				const value = configured?.value;
				if (
					typeof value === "object" &&
					value !== null &&
					!Array.isArray(value) &&
					typeof value.provider === "string" &&
					typeof value.modelId === "string"
				) {
					return { provider: value.provider, modelId: value.modelId };
				}
				const available = (await activeRuntime.listModels()).find((model) => model.available);
				if (!available)
					throw new WorkbenchError("conflict", "No authenticated model is available for assistant generation");
				return { provider: available.provider, modelId: available.modelId };
			},
		});
		await assistantDrafts.initializeRecovery();
		const excludedProjects = new Set(
			(await repositories.projects.pendingDeletions()).map((intent) => intent.project.id),
		);
		const legacyUser = await lstat(join(paths.workspace, "USER.md")).catch((error: unknown) => {
			if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
				return undefined;
			throw error;
		});
		// Old write journals address workspace/USER.md. Recover them before publishing the root document.
		if (legacyUser && !(await settings.get("memory.userDocumentLocation"))) {
			const legacyMemory = new MemoryService(
				paths,
				{
					requireMemory: (path) => pathPolicy.requireWorkspace(path),
					requireWorkspace: (path) => pathPolicy.requireWorkspace(path),
					isProtectedMemoryPath: (path) => pathPolicy.isProtectedMemoryPath(path),
				},
				repositories.memory,
				undefined,
				repositories.semantic,
			);
			legacyMemory.attachSemantics(semantic);
			await legacyMemory.recoverAppliedCandidates(excludedProjects);
		} else await memory.recoverAppliedCandidates(excludedProjects);
		const existingProjects = await projects.list();
		await workspace.consolidateLegacyMemory(
			pathPolicy,
			existingProjects.map((project) => project.slug),
		);
		for (const project of existingProjects) {
			const legacyPath = `projects/${project.slug}/MEMORY.md`;
			await repositories.semantic.relocateProjectFile(project.id, legacyPath, `projects/${project.slug}/AGENTS.md`);
			await repositories.memory.deleteFile("project", project.id, legacyPath);
		}
		await synchronizeMemoryIndex(paths, memory, await projects.list());
		await memory.recoverAppliedCandidates(excludedProjects);
		if (!(await settings.get("memory.userDocumentLocation")))
			await settings.set("memory.userDocumentLocation", "workbench-root-v2");
		await learning.initializeRecovery();
		const events = new AgentEventBroker(
			sessions,
			logger,
			500,
			async (input) => {
				const session = input.sessionId ? await repositories.sessions.get(input.sessionId) : undefined;
				await activity.record({ ...input, projectId: input.projectId ?? session?.projectId });
			},
			(event) => diagnostics.recordNormalized(event),
			coordinator,
			async (event) => {
				if (!(await projectLearning.onRunSettled(event))) await checkpointReview.onRunSettled(event);
			},
		);
		const taskCleanup = new TaskCleanupService({
			tasks,
			sessions,
			sessionRepository: repositories.sessions,
			events,
			coordinator,
			logger,
			compact: () => database!.compact(),
			forgetDiagnostics: (id) => diagnostics.forgetSession(id),
		});
		await taskCleanup.recover();
		await knowledge.recover(await projects.list());
		const services: WorkbenchServices = {
			browserUse: browsers,
			computerUse: desktop,
			activity,
			profiles,
			capabilities,
			connections,
			assistantDrafts,
			projects,
			learning: projectLearning,
			projectDeletion,
			tasks,
			memory,
			knowledge,
			memoryState,
			artifacts,
			semantic,
			retrieval: memoryRetrieval,
			checkpointReview,
			settings,
			skills,
			modelSettings,
			webSearch,
			skillImports,
			permissions: permissionService,
			sessions,
			files,
			taskCleanup,
		};
		return new WorkbenchApplication({
			paths,
			repositories,
			services,
			runtime: activeRuntime,
			events,
			context,
			logger,
			diagnostics,
			oauth,
			secrets: secretStore,
			mcp,
			coordinator,
			database,
			instanceLock,
			sandboxProtectedPaths: [
				paths.state,
				paths.config,
				paths.userMemory,
				resolve(options.agentDir ?? getAgentDir()),
			],
		});
	} catch (error) {
		await runCleanupSteps([
			() => permissions?.dispose(),
			() => runtime?.dispose(),
			() => browserUse?.dispose(),
			() => computerUse?.dispose(),
			() => mcp?.dispose(),
			() => oauth?.dispose(),
			() => knowledgeService?.dispose(),
			() => database?.close(),
			() => instanceLock.release(),
		]);
		throw error;
	}
}

async function synchronizeMemoryIndex(
	paths: WorkbenchPaths,
	memory: MemoryService,
	projects: Project[],
): Promise<void> {
	await memory.reindex("user", "USER.md");
	await memory.reindex("global", "MEMORY.md");
	for (const project of projects) {
		if (project.status !== "failed" && project.status !== "creating") {
			await memory.reindex("project", `projects/${project.slug}/AGENTS.md`, project.id);
		}
	}
	const dailyFiles = await readdir(paths.memory, { withFileTypes: true });
	for (const file of dailyFiles) {
		if (file.isFile() && /^\d{4}-\d{2}-\d{2}\.md$/u.test(file.name)) {
			await memory.reindex("daily", `memory/${file.name}`);
		}
	}
}
