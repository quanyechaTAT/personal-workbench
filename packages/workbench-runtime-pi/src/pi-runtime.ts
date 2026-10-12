import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, unlink } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, relative, resolve } from "node:path";
import type { Api, AssistantMessage, Message, Model } from "@earendil-works/pi-ai";
import {
	type AgentSession,
	type AgentSessionEvent,
	createAgentSession,
	createBashToolDefinition,
	createPowerShellToolDefinition,
	DefaultResourceLoader,
	type ExtensionFactory,
	ModelRuntime,
	type PowerShellOperations,
	parseSkillBlock,
	SessionManager,
	SettingsManager,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
	type AgentEvent,
	type AgentRuntime,
	type CreateRuntimeSessionOptions,
	DEFAULT_SANDBOX_POLICY,
	DEVELOPMENT_ENTRY_TYPE,
	type DevelopmentState,
	errorMessage,
	isDevelopmentState,
	type ResumeRuntimeSessionOptions,
	type RuntimeCommandResult,
	type RuntimeContextOptions,
	RuntimeError,
	type RuntimeInput,
	type RuntimeInputQueue,
	type RuntimeModel,
	type RuntimeModelRef,
	type RuntimeQueueAction,
	type RuntimeQueuedMessage,
	type RuntimeSandboxPolicy,
	type RuntimeSession,
	type RuntimeSessionCommand,
	type RuntimeSessionFilter,
	type RuntimeSessionKind,
	type RuntimeSessionStatus,
	type RuntimeThinkingLevel,
	type RuntimeToolLease,
	type RuntimeToolProvider,
	type RuntimeTranscriptContent,
	type RuntimeTranscriptMessage,
	type RuntimeTurnContext,
	type SendMessageOptions,
	type SessionUsage,
	settleDevelopment,
} from "@earendil-works/workbench-runtime";
import { AsyncEventQueue } from "./async-event-queue.ts";
import { attachmentTranscriptEntries, CHAT_ATTACHMENTS_ENTRY } from "./chat-attachments.ts";
import { createCompactionExtension } from "./compaction-extension.ts";
import { createExternalToolExtension } from "./external-tool-extension.ts";
import { generateKnowledgeHypothesis, generateKnowledgeQuery } from "./knowledge-query.ts";
import { createPersistentShell } from "./persistent-shell.ts";
import { PI_WORKBENCH_COMMANDS } from "./pi-commands.ts";
import { normalizeUsage, PiEventAdapter } from "./pi-event-adapter.ts";
import { PiModelCatalog } from "./pi-model-catalog.ts";
import { deriveSessionUsage, STEP_TIMING_ENTRY, TURN_USAGE_ENTRY } from "./pi-usage.ts";
import { PiWebSearch } from "./pi-web-search.ts";
import { providerError } from "./provider-error.ts";
import { createPtcExtension } from "./ptc-extension.ts";
import { createSandboxOperations } from "./sandbox-operations.ts";
import { createScreenshotExtension, isScreenshotResult } from "./screenshot-extension.ts";
import { purgeScreenshotHistory } from "./screenshot-history.ts";
import { generateSessionTitle } from "./session-title.ts";
import { createTerminalTools, TerminalSessions } from "./terminal-sessions.ts";
import { adaptThinkingPayload } from "./thinking-payload.ts";
import type { WorkbenchPermissionEvent } from "./workbench-extension.ts";

export interface PiSessionExtensionContext {
	getToolSignal(toolCallId: string): AbortSignal | undefined;
	sessionId: string;
	cwd: string;
	sandbox: RuntimeSandboxPolicy;
	powerShellOperations: PowerShellOperations;
	emitPermissionEvent(event: WorkbenchPermissionEvent): void;
	emitDevelopmentEvent(state: DevelopmentState): void;
}

export interface PiRuntimeOptions {
	getCompactionPolicy?(): Promise<{ enabled: boolean; thresholdPercent: number }>;
	shellEnvironment?(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
	agentDir: string;
	sessionDir: string;
	modelRuntime?: ModelRuntime;
	defaultModel?: Model<Api>;
	toolNames?: string[];
	customTools?: ToolDefinition[];
	toolProvider?: RuntimeToolProvider;
	extensionFactories?: ExtensionFactory[];
	sessionExtensionFactories?(context: PiSessionExtensionContext): ExtensionFactory[];
	onRawEvent?(input: { sessionId: string; event: AgentSessionEvent }): void;
}

interface PiSessionHandle {
	development?: DevelopmentState;
	compactionError?: Error;
	cleanup?(): Promise<void>;
	terminals?: TerminalSessions;
	session: AgentSession;
	cwd: string;
	kind: RuntimeSessionKind;
	status: RuntimeSessionStatus;
	referencePath: string;
	activeRun?: Promise<void>;
	activeStream?: { adapter: PiEventAdapter; queue: AsyncEventQueue<AgentEvent> };
	abortRequested: boolean;
	activeRunId?: string;
	steeringSubmission?: Promise<void>;
	followUp: RuntimeQueuedMessage[];
	queueOpen: boolean;
	queueMutation: boolean;
	queueRevision: number;
	toolLease?: RuntimeToolLease;
	terminalCleanup?: Promise<void>;
}

interface CreatedPiSession {
	cleanup?(): Promise<void>;
	terminals?: TerminalSessions;
	session: AgentSession;
	toolLease?: RuntimeToolLease;
}

function isMessage(value: unknown): value is Message {
	if (typeof value !== "object" || value === null || !("role" in value)) return false;
	return value.role === "user" || value.role === "assistant" || value.role === "toolResult";
}

function isAssistantMessage(value: unknown): value is AssistantMessage {
	return isMessage(value) && value.role === "assistant";
}

function pathEquals(left: string, right: string): boolean {
	const normalizedLeft = resolve(left);
	const normalizedRight = resolve(right);
	return process.platform === "win32"
		? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
		: normalizedLeft === normalizedRight;
}

function isContained(parent: string, child: string): boolean {
	const pathFromParent = relative(parent, child);
	return pathFromParent === "" || (!pathFromParent.startsWith("..") && !isAbsolute(pathFromParent));
}

function textContent(text: string): RuntimeTranscriptContent {
	return { type: "text", text };
}

function userTextContent(text: string): RuntimeTranscriptContent[] {
	const skill = parseSkillBlock(text);
	if (!skill) return [textContent(text)];
	return [
		{ type: "skill", skillName: skill.name, text: skill.content },
		...(skill.userMessage ? [textContent(skill.userMessage)] : []),
	];
}

function transcriptContent(message: Message, labels: ReadonlyMap<string, string>): RuntimeTranscriptContent[] {
	if (message.role === "user") {
		if (typeof message.content === "string") return userTextContent(message.content);
		return message.content.flatMap<RuntimeTranscriptContent>((content) =>
			content.type === "text"
				? userTextContent(content.text)
				: [{ type: "image", data: content.data, mimeType: content.mimeType }],
		);
	}
	if (message.role === "toolResult") {
		const content: RuntimeTranscriptContent[] = message.content.map((content) =>
			content.type === "text"
				? textContent(content.text)
				: isScreenshotResult(message.toolName, message.details)
					? textContent("[截图已清理]")
					: { type: "image" as const, data: content.data, mimeType: content.mimeType },
		);
		const details: unknown = message.details;
		if (typeof details === "object" && details !== null && "ptcCalls" in details && Array.isArray(details.ptcCalls)) {
			for (const entry of details.ptcCalls) {
				const call: unknown = entry;
				if (
					typeof call !== "object" ||
					call === null ||
					!("toolName" in call) ||
					typeof call.toolName !== "string" ||
					!("arguments" in call) ||
					!("result" in call) ||
					!("isError" in call)
				)
					continue;
				content.push({
					type: "text",
					text: `${call.toolName} (${call.isError ? "失败" : "完成"})\n${JSON.stringify({ arguments: call.arguments, result: call.result }, null, 2)}`,
				});
			}
		}
		return content;
	}
	return message.content.map((content) => {
		switch (content.type) {
			case "text":
				return textContent(content.text);
			case "thinking":
				return { type: "reasoning", text: content.thinking };
			case "toolCall":
				return {
					type: "tool-call",
					toolCallId: content.id,
					toolName: content.name,
					toolLabel: labels.get(content.name),
					arguments: content.arguments,
				};
			default:
				throw new RuntimeError("runtime_failure", "Pi returned an unsupported assistant content block");
		}
	});
}

export class PiRuntime implements AgentRuntime {
	readonly id = "pi";
	readonly modelCatalog: PiModelCatalog;
	readonly webSearch: PiWebSearch;
	private readonly handles = new Map<string, PiSessionHandle>();
	private readonly turnContexts = new Map<string, RuntimeTurnContext>();
	private readonly toolSignals = new Map<string, AbortSignal>();
	private readonly screenshotHistoryCleanups = new Map<string, Promise<void>>();
	private readonly options: PiRuntimeOptions;
	private readonly modelRuntime: ModelRuntime;
	private disposed = false;

	private constructor(options: PiRuntimeOptions, modelRuntime: ModelRuntime) {
		this.options = options;
		this.modelRuntime = modelRuntime;
		this.modelCatalog = new PiModelCatalog(modelRuntime);
		this.webSearch = new PiWebSearch(async () => {
			const provider = this.modelCatalog.searchProvider();
			return provider ? (await modelRuntime.getAuth(provider))?.auth.apiKey : undefined;
		});
	}

	static async create(options: PiRuntimeOptions): Promise<PiRuntime> {
		await mkdir(options.sessionDir, { recursive: true });
		await mkdir(options.agentDir, { recursive: true });
		const modelRuntime =
			options.modelRuntime ??
			(await ModelRuntime.create({
				authPath: resolve(options.agentDir, "auth.json"),
				modelsPath: resolve(options.agentDir, "models.json"),
			}));
		return new PiRuntime(options, modelRuntime);
	}

	async createSession(options: CreateRuntimeSessionOptions): Promise<RuntimeSession> {
		this.assertAvailable();
		const cwd = resolve(options.cwd);
		await mkdir(cwd, { recursive: true });
		const sessionManager = SessionManager.create(cwd, this.options.sessionDir, {
			id: options.id ?? randomUUID(),
		});
		const bootstrap = await this.createPiSession(sessionManager, { model: options.model }, true);
		const sessionFile = bootstrap.session.sessionFile;
		if (!sessionFile) {
			bootstrap.session.dispose();
			throw new RuntimeError("runtime_failure", "Pi did not allocate a persistent session file");
		}
		try {
			bootstrap.session.exportToJsonl(sessionFile);
		} finally {
			bootstrap.session.dispose();
		}
		const reopened = SessionManager.open(sessionFile, this.options.sessionDir);
		const session = await this.createPiSession(reopened, options, false);
		const handle = this.register(session, options.kind, cwd, sessionFile);
		return this.describe(handle);
	}

	async resumeSession(options: ResumeRuntimeSessionOptions): Promise<RuntimeSession> {
		this.assertAvailable();
		if (options.reference.runtime !== this.id) {
			throw new RuntimeError(
				"invalid_reference",
				`Expected runtime ${this.id}, received ${options.reference.runtime}`,
			);
		}
		const existing = this.handles.get(options.reference.runtimeSessionId);
		if (existing) return this.describe(existing);
		const referencePath = await this.validateReferencePath(options.reference.opaque);
		await this.cleanScreenshotHistory(referencePath);
		let manager: SessionManager;
		try {
			manager = SessionManager.open(referencePath, this.options.sessionDir);
		} catch (error) {
			throw new RuntimeError("session_corrupt", `Cannot open Pi session: ${errorMessage(error)}`, { cause: error });
		}
		if (manager.getSessionId() !== options.reference.runtimeSessionId) {
			throw new RuntimeError("invalid_reference", "Pi session id does not match its Workbench reference");
		}
		if (options.expectedCwd && !pathEquals(manager.getCwd(), options.expectedCwd)) {
			throw new RuntimeError("invalid_reference", "Pi session cwd does not match the bound Workbench project");
		}
		const session = await this.createPiSession(
			manager,
			{
				context: options.context,
				model: options.model,
			},
			false,
		);
		const handle = this.register(session, options.kind, manager.getCwd(), referencePath);
		return this.describe(handle);
	}

	async *sendMessage(sessionId: string, input: RuntimeInput, options: SendMessageOptions): AsyncIterable<AgentEvent> {
		const handle = this.requireHandle(sessionId);
		if (handle.status !== "idle") {
			throw new RuntimeError("session_busy", `Session ${sessionId} is ${handle.status}`);
		}
		if (input.images?.length && !handle.session.model?.input.includes("image"))
			throw new RuntimeError("model_unavailable", "当前模型未启用图片输入，请选择支持视觉的模型后重试");
		handle.status = "running";
		handle.abortRequested = options.signal?.aborted ?? false;
		handle.activeRunId = options.runId;
		handle.development = undefined;
		handle.queueOpen = true;
		handle.queueRevision = 0;
		if (options.context) this.turnContexts.set(sessionId, options.context);
		else this.turnContexts.delete(sessionId);
		const queue = new AsyncEventQueue<AgentEvent>();
		const adapter = new PiEventAdapter(
			sessionId,
			options.runId,
			new Map(handle.toolLease?.tools.map((tool) => [tool.name, tool.label])),
		);
		queue.push(
			adapter.create("run.started", {
				inputId: input.id,
				historyMessageCount: handle.session.messages.filter(isMessage).length,
			}),
		);
		queue.push(adapter.create("agent.status", { status: "running" }));
		handle.session.sessionManager.appendCustomEntry(TURN_USAGE_ENTRY, options.runId);
		let timing: { start: number; first?: number } | undefined;
		const unsubscribe = handle.session.subscribe((event: AgentSessionEvent) => {
			if (event.type === "compaction_start") handle.compactionError = undefined;
			this.options.onRawEvent?.({ sessionId, event });
			for (const adapted of adapter.adapt(event)) {
				if (adapted.type === "input.queue") {
					handle.queueRevision++;
					adapted.data = this.readInputQueue(sessionId);
				}
				queue.push(adapted);
			}
			if (event.type === "compaction_end" && handle.compactionError)
				queue.push(
					adapter.create("agent.status", {
						status: "running",
						detail: `上下文压缩失败，已保留原上下文：${handle.compactionError.message}`,
					}),
				);
			if (event.type === "message_start" && isAssistantMessage(event.message)) timing = { start: performance.now() };
			if (
				event.type === "message_update" &&
				timing &&
				timing.first === undefined &&
				["text_delta", "thinking_delta", "toolcall_delta"].includes(event.assistantMessageEvent.type)
			)
				timing.first = performance.now();
			if (event.type === "message_end" && isAssistantMessage(event.message)) {
				if (timing) {
					const end = performance.now();
					handle.session.sessionManager.appendCustomEntry(STEP_TIMING_ENTRY, {
						llmMs: end - timing.start,
						firstTokenMs: timing.first === undefined ? undefined : timing.first - timing.start,
						decodeMs: timing.first === undefined ? undefined : end - timing.first,
						outputTokens: event.message.usage.output,
					});
				}
				timing = undefined;
			}
			if (event.type === "message_end" || event.type === "compaction_end")
				queueMicrotask(() => {
					if (handle.activeStream?.adapter === adapter)
						queue.push(
							adapter.create(
								"usage.updated",
								this.usageForManager(
									handle.session.sessionManager,
									handle.session.model
										? { provider: handle.session.model.provider, modelId: handle.session.model.id }
										: undefined,
								),
							),
						);
				});
		});
		handle.activeStream = { adapter, queue };
		const onAbort = () => {
			handle.abortRequested = true;
			handle.followUp = [];
			handle.queueOpen = false;
			handle.terminalCleanup = handle.terminals
				?.closeAll()
				.catch((error: unknown) => queue.push(adapter.create("run.failed", { message: errorMessage(error) })));
			handle.session.clearQueue();
			void handle.session
				.abort()
				.catch((error: unknown) => queue.push(adapter.create("run.failed", { message: errorMessage(error) })));
		};
		options.signal?.addEventListener("abort", onAbort, { once: true });
		const run = this.runPrompt(sessionId, handle, input, adapter, queue).finally(() => {
			options.signal?.removeEventListener("abort", onAbort);
			unsubscribe();
			queue.close();
		});
		handle.activeRun = run;
		let consumed = false;
		try {
			for await (const event of queue) yield event;
			await run;
			consumed = true;
		} finally {
			if (!consumed) await this.abort(sessionId);
			await run;
		}
	}

	async steerMessage(sessionId: string, text: string, runId: string): Promise<void> {
		const handle = this.requireSteeringHandle(sessionId, runId);
		if (!text.trim()) throw new RuntimeError("runtime_failure", "追加指令不能为空");
		const submission = (handle.steeringSubmission ?? Promise.resolve()).then(async () => {
			this.requireSteeringHandle(sessionId, runId);
			await handle.session.steer(text, undefined, { source: "rpc" });
			this.requireSteeringHandle(sessionId, runId);
		});
		// Keep the run alive until in-flight queue submissions settle, including rejected ones.
		handle.steeringSubmission = submission.then(
			() => undefined,
			() => undefined,
		);
		await submission;
	}

	readInputQueue(sessionId: string): RuntimeInputQueue {
		const handle = this.requireHandle(sessionId);
		return {
			revision: handle.queueRevision,
			steering: [...handle.session.getSteeringMessages()],
			followUp: structuredClone(handle.followUp),
		};
	}

	async queueMessage(sessionId: string, text: string, runId: string): Promise<RuntimeInputQueue> {
		const handle = this.requireQueueHandle(sessionId, runId);
		if (!text.trim()) throw new RuntimeError("runtime_failure", "排队消息不能为空");
		if (handle.followUp.length >= 50) throw new RuntimeError("session_busy", "最多排队 50 条消息");
		handle.followUp.push({ id: randomUUID(), text: text.trim() });
		return this.publishInputQueue(handle);
	}

	async updateQueuedMessage(
		sessionId: string,
		itemId: string,
		action: RuntimeQueueAction,
		runId: string,
	): Promise<RuntimeInputQueue> {
		const handle = this.requireQueueHandle(sessionId, runId);
		if (handle.queueMutation) throw new RuntimeError("session_busy", "排队消息正在更新，请稍后再试");
		const item = handle.followUp.find((entry) => entry.id === itemId);
		if (!item) throw new RuntimeError("session_busy", "消息已经送达或被删除");
		if (action.kind === "edit") {
			if (!action.text.trim()) throw new RuntimeError("runtime_failure", "排队消息不能为空");
			item.text = action.text.trim();
		} else if (action.kind === "remove") {
			handle.followUp = handle.followUp.filter((entry) => entry.id !== itemId);
		} else {
			this.requireSteeringHandle(sessionId, runId);
			handle.queueMutation = true;
			const submission = (handle.steeringSubmission ?? Promise.resolve()).then(async () => {
				this.requireSteeringHandle(sessionId, runId);
				await handle.session.steer(item.text, undefined, { source: "rpc" });
				this.requireSteeringHandle(sessionId, runId);
				handle.followUp = handle.followUp.filter((entry) => entry.id !== itemId);
			});
			handle.steeringSubmission = submission.then(
				() => undefined,
				() => undefined,
			);
			try {
				await submission;
			} finally {
				handle.queueMutation = false;
			}
		}
		return this.publishInputQueue(handle);
	}

	private requireQueueHandle(sessionId: string, runId: string): PiSessionHandle {
		const handle = this.requireHandle(sessionId);
		if (
			handle.status !== "running" ||
			handle.activeRunId !== runId ||
			handle.abortRequested ||
			!handle.activeStream ||
			!handle.queueOpen
		)
			throw new RuntimeError("session_busy", "当前任务已结束或正在停止，请重新发送消息");
		return handle;
	}

	private publishInputQueue(handle: PiSessionHandle): RuntimeInputQueue {
		handle.queueRevision++;
		const snapshot = this.readInputQueue(handle.session.sessionId);
		const active = handle.activeStream;
		if (active) active.queue.push(active.adapter.create("input.queue", snapshot));
		return snapshot;
	}

	private requireSteeringHandle(sessionId: string, runId: string): PiSessionHandle {
		const handle = this.requireHandle(sessionId);
		if (
			handle.status !== "running" ||
			handle.activeRunId !== runId ||
			handle.abortRequested ||
			!handle.activeStream ||
			handle.activeStream.adapter.didSettle ||
			handle.session.isIdle
		)
			throw new RuntimeError("session_busy", "当前任务正在准备、停止或已结束，请确认任务状态后重试");
		return handle;
	}

	async abort(sessionId: string): Promise<void> {
		const handle = this.requireHandle(sessionId);
		await handle.terminals?.closeAll();
		if (handle.status === "idle") return;
		handle.abortRequested = true;
		handle.status = "aborting";
		handle.queueOpen = false;
		handle.followUp = [];
		handle.session.clearQueue();
		await handle.session.abort();
		await handle.activeRun;
	}

	async getSession(sessionId: string): Promise<RuntimeSession> {
		return this.describe(this.requireHandle(sessionId));
	}

	async generateSessionTitle(sessionId: string, prompt: string, signal: AbortSignal): Promise<string | undefined> {
		const model = this.requireHandle(sessionId).session.model;
		return model ? generateSessionTitle(this.modelRuntime, model, prompt, signal) : undefined;
	}
	async generateKnowledgeQueries(
		prompt: string,
		signal: AbortSignal,
		reference?: RuntimeModelRef,
	): Promise<string | undefined> {
		return this.completeKnowledge(prompt, signal, reference, "query");
	}
	async generateKnowledgeHypothesis(
		prompt: string,
		signal: AbortSignal,
		reference?: RuntimeModelRef,
	): Promise<string | undefined> {
		return this.completeKnowledge(prompt, signal, reference, "hypothesis");
	}
	private async completeKnowledge(
		prompt: string,
		signal: AbortSignal,
		reference: RuntimeModelRef | undefined,
		kind: "query" | "hypothesis",
	): Promise<string | undefined> {
		this.assertAvailable();
		const selected =
			reference ??
			(this.options.defaultModel
				? { provider: this.options.defaultModel.provider, modelId: this.options.defaultModel.id }
				: this.modelCatalog.listModels().find((model) => model.available));
		if (!selected) return undefined;
		return (kind === "hypothesis" ? generateKnowledgeHypothesis : generateKnowledgeQuery)(
			this.modelRuntime,
			this.resolveModel(selected),
			prompt,
			signal,
		);
	}

	async listSessions(filter: RuntimeSessionFilter = {}): Promise<RuntimeSession[]> {
		return [...this.handles.values()]
			.filter((handle) => !filter.cwd || pathEquals(handle.cwd, filter.cwd))
			.filter((handle) => !filter.status || handle.status === filter.status)
			.map((handle) => this.describe(handle));
	}

	async readTranscript(sessionId: string): Promise<RuntimeTranscriptMessage[]> {
		const handle = this.requireHandle(sessionId);
		return this.convertTranscript(attachmentTranscriptEntries(handle.session.sessionManager.getBranch()));
	}

	async readTranscriptReference(options: ResumeRuntimeSessionOptions): Promise<RuntimeTranscriptMessage[]> {
		const manager = await this.readReferenceManager(options);
		return this.convertTranscript(attachmentTranscriptEntries(manager.getBranch()));
	}

	async readDevelopmentState(options: ResumeRuntimeSessionOptions): Promise<DevelopmentState | undefined> {
		const manager = await this.readReferenceManager(options);
		for (const entry of manager.getBranch().reverse()) {
			if (entry.type !== "custom" || entry.customType !== DEVELOPMENT_ENTRY_TYPE || !isDevelopmentState(entry.data))
				continue;
			const state = structuredClone(entry.data);
			const handle = this.handles.get(options.reference.runtimeSessionId);
			if (handle?.activeRunId !== state.runId) {
				for (const check of state.checks) {
					if (check.status === "running") {
						check.status = "cancelled";
						check.output = "执行已中断，未获得命令退出码。";
					}
				}
				if (state.acceptance.status === "pending") return settleDevelopment(state, "aborted");
			}
			return state;
		}
		return undefined;
	}

	async readUsage(options: ResumeRuntimeSessionOptions): Promise<SessionUsage> {
		const manager = await this.readReferenceManager(options);
		const handle = this.handles.get(options.reference.runtimeSessionId);
		const reference = handle?.session.model
			? { provider: handle.session.model.provider, modelId: handle.session.model.id }
			: (options.model ?? manager.buildSessionContext().model ?? undefined);
		return this.usageForManager(manager, reference);
	}

	private usageForManager(manager: SessionManager, model?: RuntimeModelRef): SessionUsage {
		const available = this.modelCatalog
			.listModels()
			.find((value) => value.provider === model?.provider && value.modelId === model?.modelId);
		return deriveSessionUsage(manager.getEntries(), manager.getBranch(), model, available?.contextWindow);
	}

	private async readReferenceManager(options: ResumeRuntimeSessionOptions): Promise<SessionManager> {
		this.assertAvailable();
		if (options.reference.runtime !== this.id)
			throw new RuntimeError("invalid_reference", "Unexpected session runtime");
		const path = await this.validateReferencePath(options.reference.opaque);
		await this.cleanScreenshotHistory(path);
		let manager: SessionManager;
		try {
			manager = SessionManager.open(path, this.options.sessionDir);
		} catch (error) {
			throw new RuntimeError("session_corrupt", `Cannot read Pi session: ${errorMessage(error)}`, { cause: error });
		}
		if (manager.getSessionId() !== options.reference.runtimeSessionId)
			throw new RuntimeError("invalid_reference", "Pi session id does not match its Workbench reference");
		if (options.expectedCwd && !pathEquals(manager.getCwd(), options.expectedCwd))
			throw new RuntimeError("invalid_reference", "Pi session cwd does not match the bound Workbench project");
		return manager;
	}

	private convertTranscript(entries: ReturnType<typeof attachmentTranscriptEntries>): RuntimeTranscriptMessage[] {
		const messages = entries.map((entry) => entry.message);
		const labels = new Map<string, string>();
		for (const message of messages) {
			if (!isMessage(message) || message.role !== "toolResult") continue;
			const details: unknown = message.details;
			if (
				typeof details === "object" &&
				details !== null &&
				"toolLabel" in details &&
				typeof details.toolLabel === "string"
			)
				labels.set(message.toolName, details.toolLabel);
		}
		return messages.flatMap<RuntimeTranscriptMessage>((value, index): RuntimeTranscriptMessage[] => {
			if (!isMessage(value)) return [];
			const metadata = entries[index];
			const content = transcriptContent(value, labels);
			if (value.role === "user" && metadata.suffixLength) {
				const text = [...content].reverse().find((part) => part.type === "text");
				if (text?.text?.endsWith("\n</workbench-uploaded-files>"))
					text.text = text.text.slice(0, -metadata.suffixLength);
			}
			const base = {
				id: `pi-${value.timestamp}-${index}`,
				piEntryId: entries[index]?.id,
				content,
				attachments: metadata.attachments,
				// Run boundaries use Pi's durable local entry time, never a provider's message clock.
				timestamp: entries[index].timestamp,
			};
			if (value.role === "toolResult") {
				const details: unknown = value.details;
				const calls =
					typeof details === "object" &&
					details !== null &&
					"ptcCalls" in details &&
					Array.isArray(details.ptcCalls)
						? details.ptcCalls
						: [];
				const evidence = calls
					.map((call: unknown) => {
						if (typeof call !== "object" || call === null || !("result" in call)) return undefined;
						return {
							result: call.result,
							isError: "isError" in call && call.isError === true,
							toolCallId: "toolCallId" in call ? String(call.toolCallId) : "",
							toolName: "toolName" in call ? String(call.toolName) : "",
						};
					})
					.filter((call) => call !== undefined);
				return [
					{
						...base,
						role: "tool" as const,
						toolCallId: value.toolCallId,
						toolName: value.toolName,
						toolLabel: labels.get(value.toolName),
						isError: value.isError || evidence.some((call) => call.isError),
						evidenceText: evidence.length ? JSON.stringify({ results: evidence }) : undefined,
						toolResults: evidence.length
							? evidence.map((call) => ({
									toolCallId: call.toolCallId,
									toolName: call.toolName,
									text: JSON.stringify(call.result),
									isError: call.isError,
								}))
							: undefined,
					},
				];
			}
			return [
				{
					...base,
					role: value.role,
					usage: value.role === "assistant" ? normalizeUsage(value.usage) : undefined,
					errorMessage:
						value.role === "assistant" && value.errorMessage
							? providerError(value.errorMessage, value.provider, this.modelCatalog.providerName(value.provider))
							: undefined,
				},
			];
		});
	}

	getCapabilities() {
		return {
			abort: true,
			steering: true,
			modelSelection: true,
			persistentSessions: true,
			reasoningStream: true,
			resume: true,
			toolStream: true,
		};
	}

	async listModels(): Promise<RuntimeModel[]> {
		return this.modelCatalog.listModels();
	}

	listCommands() {
		return PI_WORKBENCH_COMMANDS;
	}

	async executeSessionCommand(
		sessionId: string,
		command: RuntimeSessionCommand,
		signal?: AbortSignal,
	): Promise<RuntimeCommandResult> {
		const handle = this.requireHandle(sessionId);
		if (handle.status !== "idle") throw new RuntimeError("session_busy", "请在当前会话空闲时执行命令");
		if (signal?.aborted) throw new RuntimeError("runtime_failure", "命令已取消");
		await this.configureCompaction(handle.session);
		if (command.name === "session") {
			const {
				sessionFile: _file,
				sessionId: _id,
				contextUsage: _context,
				...stats
			} = handle.session.getSessionStats();
			return { type: "stats", ...stats };
		}
		if (command.name === "export") {
			const fileName = `session-${sessionId}-${randomUUID()}.${command.format}`;
			const path = resolve(this.options.sessionDir, fileName);
			try {
				if (command.format === "html") await handle.session.exportToHtml(path);
				else handle.session.exportToJsonl(path);
				return {
					type: "export",
					fileName: `session-${sessionId}.${command.format}`,
					mimeType: command.format === "html" ? "text/html" : "application/x-ndjson",
					content: await readFile(path, "utf8"),
				};
			} finally {
				await unlink(path).catch((error: unknown) => {
					if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return;
					throw error;
				});
			}
		}
		handle.status = "running";
		handle.abortRequested = false;
		let abortFailure: unknown;
		const onAbort = () => {
			void handle.session.abort().catch((error: unknown) => {
				abortFailure = error;
			});
		};
		signal?.addEventListener("abort", onAbort, { once: true });
		try {
			handle.compactionError = undefined;
			const operation = handle.session.compact(command.instructions);
			handle.activeRun = operation.then(
				() => undefined,
				() => undefined,
			);
			const result = await operation;
			if (abortFailure) throw new RuntimeError("runtime_failure", "取消压缩失败", { cause: abortFailure });
			return {
				type: "compaction",
				summary: result.summary,
				tokensBefore: result.tokensBefore,
				estimatedTokensAfter: result.estimatedTokensAfter,
			};
		} catch (error) {
			throw new RuntimeError(
				"runtime_failure",
				signal?.aborted ? "压缩已取消" : errorMessage(handle.compactionError ?? error),
				{
					cause: error,
				},
			);
		} finally {
			signal?.removeEventListener("abort", onAbort);
			handle.status = "idle";
			handle.activeRun = undefined;
		}
	}

	async selectThinkingLevel(sessionId: string, level: RuntimeThinkingLevel): Promise<RuntimeThinkingLevel> {
		const handle = this.requireHandle(sessionId);
		if (handle.status !== "idle") throw new RuntimeError("session_busy", "请等待本轮结束后再修改思考强度");
		if (handle.session.model) {
			const current = this.resolveModel({
				provider: handle.session.model.provider,
				modelId: handle.session.model.id,
			});
			if (current !== handle.session.model) await handle.session.setModel(current);
		}
		const value = level === "none" ? "off" : level;
		if (!handle.session.getAvailableThinkingLevels().includes(value))
			throw new RuntimeError("model_unavailable", "当前模型不支持所选思考强度");
		handle.session.setThinkingLevel(value);
		return level;
	}

	async selectModel(sessionId: string, reference: RuntimeModelRef): Promise<void> {
		const handle = this.requireHandle(sessionId);
		if (handle.status !== "idle") {
			throw new RuntimeError("session_busy", "Models can only be changed while the session is idle");
		}
		const model = this.resolveModel(reference);
		try {
			await handle.session.setModel(model);
			await this.configureCompaction(handle.session);
		} catch (error) {
			throw new RuntimeError("model_unavailable", errorMessage(error), { cause: error });
		}
	}

	async releaseSession(sessionId: string): Promise<void> {
		const handle = this.requireHandle(sessionId);
		if (handle.status !== "idle") {
			throw new RuntimeError("session_busy", "A running Pi session cannot be released");
		}
		handle.session.dispose();
		await handle.cleanup?.();
		await handle.toolLease?.close();
		this.handles.delete(sessionId);
	}

	async deleteSessionReference(options: ResumeRuntimeSessionOptions): Promise<void> {
		this.assertAvailable();
		if (options.reference.runtime !== this.id)
			throw new RuntimeError("invalid_reference", "Unexpected session runtime");
		const path = resolve(options.reference.opaque);
		const root = await realpath(this.options.sessionDir);
		const parent = await realpath(dirname(path));
		if (!isContained(root, parent) || extname(path) !== ".jsonl")
			throw new RuntimeError("invalid_reference", "Session deletion is outside the Pi history directory");
		const metadata = await lstat(path).catch((error: unknown) => {
			if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
				return undefined;
			throw error;
		});
		if (metadata) {
			if (metadata.isSymbolicLink() || !metadata.isFile())
				throw new RuntimeError("invalid_reference", "Session deletion requires a regular history file");
			await this.readTranscriptReference(options);
		}
		if (this.handles.has(options.reference.runtimeSessionId))
			await this.releaseSession(options.reference.runtimeSessionId);
		if (metadata) await unlink(path);
	}

	async dispose(): Promise<void> {
		if (this.disposed) return;
		for (const [sessionId, handle] of this.handles) {
			if (handle.status !== "idle") await this.abort(sessionId);
			handle.session.dispose();
			await handle.cleanup?.();
			await handle.toolLease?.close();
		}
		this.handles.clear();
		await this.options.toolProvider?.dispose();
		this.disposed = true;
	}

	private async runPrompt(
		sessionId: string,
		handle: PiSessionHandle,
		input: RuntimeInput,
		adapter: PiEventAdapter,
		queue: AsyncEventQueue<AgentEvent>,
	): Promise<void> {
		try {
			if (!handle.abortRequested) {
				if (handle.session.model) {
					const current = this.resolveModel({
						provider: handle.session.model.provider,
						modelId: handle.session.model.id,
					});
					if (current !== handle.session.model) {
						const thinking = handle.session.thinkingLevel;
						await handle.session.setModel(current);
						handle.session.setThinkingLevel(thinking);
					}
				}
				await this.configureCompaction(handle.session);
				// Own the next-request queue so edits/removals are atomic. Pi's public
				// followUp queue cannot mutate individual occurrences safely while draining.
				let next: string | undefined = input.text + (input.attachmentText ?? "");
				let followUp = false;
				while (next !== undefined && !handle.abortRequested) {
					adapter.beginPrompt(followUp);
					// An empty marker also clears an interrupted prompt's unconsumed references.
					handle.session.sessionManager.appendCustomEntry(CHAT_ATTACHMENTS_ENTRY, {
						attachments: followUp ? [] : (input.attachments ?? []),
						suffixLength: followUp ? 0 : (input.attachmentText?.length ?? 0),
					});
					await handle.session.prompt(next, { images: followUp ? undefined : input.images });
					await handle.steeringSubmission;
					const last = handle.session.messages.at(-1);
					if (!adapter.didSettle || (isAssistantMessage(last) && ["error", "aborted"].includes(last.stopReason)))
						break;
					next = handle.followUp.shift()?.text;
					followUp = true;
					this.publishInputQueue(handle);
				}
			}
			handle.queueOpen = false;
			await handle.steeringSubmission;
			await handle.terminalCleanup;
			if (handle.followUp.length) {
				handle.followUp = [];
				this.publishInputQueue(handle);
			}
			const lastMessage = handle.session.messages.at(-1);
			const outcome =
				handle.abortRequested || (isAssistantMessage(lastMessage) && lastMessage.stopReason === "aborted")
					? "aborted"
					: (isAssistantMessage(lastMessage) && lastMessage.stopReason === "error") || !adapter.didSettle
						? "failed"
						: "completed";
			if (handle.development?.runId === adapter.runId) {
				handle.development = settleDevelopment(handle.development, outcome);
				handle.session.sessionManager.appendCustomEntry(DEVELOPMENT_ENTRY_TYPE, handle.development);
				queue.push(adapter.create("development.updated", handle.development));
			}
			if (handle.abortRequested || (isAssistantMessage(lastMessage) && lastMessage.stopReason === "aborted")) {
				queue.push(adapter.create("run.aborted", { reason: "User requested stop" }));
			} else if (isAssistantMessage(lastMessage) && lastMessage.stopReason === "error") {
				queue.push(
					adapter.create("run.failed", {
						message: providerError(
							lastMessage.errorMessage ?? "模型请求失败",
							lastMessage.provider,
							this.modelCatalog.providerName(lastMessage.provider),
						),
						code: lastMessage.stopReason,
					}),
				);
			} else if (!adapter.didSettle) {
				queue.push(adapter.create("run.failed", { message: "Pi prompt returned before the agent settled" }));
			} else {
				queue.push(
					adapter.create("run.completed", {
						finalMessageId: adapter.finalMessageId,
						acceptance: handle.development?.acceptance,
					}),
				);
			}
		} catch (error) {
			handle.queueOpen = false;
			handle.followUp = [];
			this.publishInputQueue(handle);
			if (handle.development?.runId === adapter.runId) {
				handle.development = settleDevelopment(handle.development, handle.abortRequested ? "aborted" : "failed");
				handle.session.sessionManager.appendCustomEntry(DEVELOPMENT_ENTRY_TYPE, handle.development);
				queue.push(adapter.create("development.updated", handle.development));
			}
			if (handle.abortRequested) {
				queue.push(adapter.create("run.aborted", { reason: errorMessage(error) }));
			} else {
				queue.push(adapter.create("run.failed", { message: errorMessage(error) }));
			}
		} finally {
			handle.queueOpen = false;
			await handle.steeringSubmission;
			await handle.terminalCleanup;
			handle.terminalCleanup = undefined;
			if (handle.session.pendingMessageCount > 0) handle.session.clearQueue();
			handle.followUp = [];
			handle.steeringSubmission = undefined;
			handle.status = "idle";
			handle.activeRun = undefined;
			handle.activeRunId = undefined;
			this.turnContexts.delete(sessionId);
			queue.push(adapter.create("agent.status", { status: "idle" }));
			handle.activeStream = undefined;
		}
	}

	private async createPiSession(
		manager: SessionManager,
		options: Pick<CreateRuntimeSessionOptions, "context" | "model"> | undefined,
		bootstrap: boolean,
	): Promise<CreatedPiSession> {
		const settingsManager = SettingsManager.create(manager.getCwd(), this.options.agentDir, {
			projectTrusted: false,
		});
		const configuredTools = options?.context?.toolNames ?? this.options.toolNames;
		const screenshots = createScreenshotExtension();
		const shellEnvironment = this.options.shellEnvironment?.(process.env) ?? {
			PATH: process.env.PATH,
			PATHEXT: process.env.PATHEXT,
			SystemRoot: process.env.SystemRoot,
			TEMP: process.env.TEMP,
			TMP: process.env.TMP,
		};
		const sandbox = options?.context?.sandbox ?? DEFAULT_SANDBOX_POLICY;
		const terminals = bootstrap ? undefined : new TerminalSessions(manager.getCwd(), shellEnvironment, sandbox);
		const powerShellOperations = terminals
			? createSandboxOperations(terminals, manager.getCwd(), "powershell")
			: undefined;
		const persistentShell =
			!bootstrap && configuredTools?.includes("persistent_shell")
				? createPersistentShell(manager.getCwd(), shellEnvironment, terminals, sandbox)
				: undefined;
		let toolLease: RuntimeToolLease | undefined;
		if (!bootstrap && this.options.toolProvider && options?.context?.toolScope) {
			toolLease = await this.options.toolProvider.open(
				{
					...options.context.toolScope,
					runtimeSessionId: manager.getSessionId(),
				},
				options.context.toolBindings ?? [],
			);
		}
		const externalExtension = toolLease
			? createExternalToolExtension({
					lease: toolLease,
					scope: { ...options!.context!.toolScope!, runtimeSessionId: manager.getSessionId() },
					runtimeSessionId: manager.getSessionId(),
					getRunId: () => this.handles.get(manager.getSessionId())?.activeRunId,
				})
			: undefined;
		let ptcSession: AgentSession | undefined;
		const ptcExtension =
			!bootstrap && configuredTools?.includes("run_code")
				? createPtcExtension({
						getSession: () => {
							if (!ptcSession) throw new RuntimeError("runtime_failure", "PTC session is not ready");
							return ptcSession;
						},
						toolNames: [...configuredTools, ...(toolLease?.tools.map((tool) => tool.name) ?? [])],
						onToolEvent: (event) => {
							this.options.onRawEvent?.({ sessionId: manager.getSessionId(), event });
							const active = this.handles.get(manager.getSessionId())?.activeStream;
							if (active) for (const adapted of active.adapter.adapt(event)) active.queue.push(adapted);
						},
						setToolSignal: (id, signal) => {
							if (signal) this.toolSignals.set(id, signal);
							else this.toolSignals.delete(id);
						},
					})
				: undefined;
		const loader = new DefaultResourceLoader({
			cwd: manager.getCwd(),
			agentDir: this.options.agentDir,
			settingsManager,
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			systemPrompt: options?.context?.systemPrompt,
			appendSystemPrompt: [
				...(options?.context?.appendSystemPrompt ?? []),
				...(!bootstrap
					? [
							`当前执行边界：${JSON.stringify({
								mode: sandbox.mode,
								networkAccess: sandbox.mode === "danger-full-access" || sandbox.networkAccess,
								writableRoots:
									sandbox.mode === "workspace-write" ? [manager.getCwd(), ...sandbox.writableRoots] : [],
							})}\n批准操作不会扩大沙箱边界。只读模式禁止修改文件；工作区可写模式限制命令及其子进程和文件工具的写入范围，.git、.codex、.agents 目录只读；danger-full-access 关闭命令沙箱。需要新增写入目录或联网时，说明原因并由用户修改“设置 → 沙箱”，不要反复请求相同批准来绕过边界。浏览器、桌面和 MCP 使用各自授权。${process.platform === "win32" ? " Windows 防火墙不会阻止本机回环服务；受限令牌模式的网络隔离较弱。" : ""}`,
						]
					: []),
			],
			additionalSkillPaths: options?.context?.skillPaths,
			extensionFactories: bootstrap
				? []
				: [
						...(this.options.extensionFactories ?? []),
						...(this.options.sessionExtensionFactories?.({
							getToolSignal: (id) => this.toolSignals.get(id),
							sessionId: manager.getSessionId(),
							cwd: manager.getCwd(),
							sandbox,
							powerShellOperations: powerShellOperations!,
							emitPermissionEvent: (event) => this.emitPermissionEvent(manager.getSessionId(), event),
							emitDevelopmentEvent: (state) => {
								const handle = this.handles.get(manager.getSessionId());
								if (handle) handle.development = state;
								const active = handle?.activeStream;
								if (active && state.runId === active.adapter.runId)
									active.queue.push(active.adapter.create("development.updated", state));
							},
						}) ?? []),
						...(externalExtension ? [externalExtension] : []),
						...(ptcExtension ? [ptcExtension] : []),
						screenshots.extension,
						createCompactionExtension({
							modelRuntime: this.modelRuntime,
							getWorkingCheckpoint: options?.context?.minimal
								? undefined
								: options?.context?.getWorkingCheckpoint,
							getRetryPolicy: () => settingsManager.getRetrySettings(),
							onFailure: (error) => {
								const handle = this.handles.get(manager.getSessionId());
								if (handle) handle.compactionError = error;
							},
						}),
						this.createTurnContextExtension(
							manager.getSessionId(),
							options?.context?.minimal ? undefined : options?.context?.getWorkingCheckpoint,
							options?.context?.minimal ? undefined : options?.context?.onModelContext,
							options?.context?.minimal ? undefined : options?.context?.onSkillLoaded,
							options?.context?.skillPaths ?? [],
						),
					],
		});
		try {
			await loader.reload();
			// ResourceLoader.reload() reloads Pi settings, so apply the Workbench-only policy afterward.
			// Pi resumes the failed model turn without replaying completed tools or changing CLI settings.
			settingsManager.applyOverrides({
				retry: { enabled: true, maxRetries: 5 },
			});
			const previous = manager.buildSessionContext().model;
			const fallback = this.modelCatalog.listModels().find((entry) => entry.available);
			const reference =
				options?.model ??
				(previous ? { provider: previous.provider, modelId: previous.modelId } : undefined) ??
				(this.options.defaultModel
					? { provider: this.options.defaultModel.provider, modelId: this.options.defaultModel.id }
					: fallback);
			const model = reference ? this.resolveModel(reference) : undefined;
			if (!model && this.modelCatalog.isManaged)
				throw new RuntimeError("model_unavailable", "尚未添加可用模型，请在设置 → 模型添加并启用模型");
			const toolNames = configuredTools
				? [...configuredTools, ...(toolLease?.tools.map((tool) => tool.name) ?? [])]
				: undefined;
			const { session } = await createAgentSession({
				cwd: manager.getCwd(),
				agentDir: this.options.agentDir,
				sessionManager: manager,
				settingsManager,
				resourceLoader: loader,
				modelRuntime: this.modelRuntime,
				model,
				noTools: bootstrap || toolNames?.length === 0 ? "all" : undefined,
				tools: bootstrap ? undefined : toolNames,
				customTools: bootstrap
					? undefined
					: [
							...(this.options.customTools ?? []),
							...(powerShellOperations
								? [
										createPowerShellToolDefinition(manager.getCwd(), {
											operations: powerShellOperations,
											exposeSessionEnvironment: false,
										}) as ToolDefinition,
									]
								: []),
							...(terminals
								? [
										createBashToolDefinition(manager.getCwd(), {
											operations: createSandboxOperations(terminals, manager.getCwd(), "bash"),
											exposeSessionEnvironment: false,
										}) as ToolDefinition,
									]
								: []),
							...(terminals ? createTerminalTools(terminals) : []),
							...(persistentShell ? [persistentShell.tool as ToolDefinition] : []),
						],
			});
			if (!bootstrap) {
				await this.configureCompaction(session);
				ptcSession = session;
				await session.bindExtensions({});
				if (toolNames) session.setActiveToolsByName(toolNames);
				if (ptcExtension) session.setActiveToolsByName(["run_code"]);
			}
			return {
				session,
				toolLease,
				terminals,
				cleanup: async () => {
					screenshots.clear();
					await persistentShell?.close();
					await terminals?.dispose();
				},
			};
		} catch (error) {
			screenshots.clear();
			await terminals?.dispose();
			await toolLease?.close();
			await persistentShell?.close();
			throw error;
		}
	}

	private createTurnContextExtension(
		sessionId: string,
		getWorkingCheckpoint?: () => Promise<string | undefined>,
		onModelContext?: RuntimeContextOptions["onModelContext"],
		onSkillLoaded?: RuntimeContextOptions["onSkillLoaded"],
		skillPaths: string[] = [],
	): ExtensionFactory {
		return (pi) => {
			let checkpoint: string | undefined;
			let runId: string | undefined;
			let request = 0;
			let loadedRun: string | undefined;
			const loaded = new Map<string, { path: string; hash: string; method: "invocation" | "read" }>();
			const recordLoad = async (path: string, cwd: string, method: "invocation" | "read", text: string) => {
				const active = this.handles.get(sessionId)?.activeRunId;
				const callback = this.turnContexts.get(sessionId)?.onSkillLoaded ?? onSkillLoaded;
				if (!active || !callback) return;
				if (loadedRun !== active) {
					loadedRun = active;
					loaded.clear();
				}
				const location = resolve(cwd, path);
				if (!skillPaths.some((known) => pathEquals(known, location))) return;
				try {
					const content = await readFile(location, "utf8");
					const body = content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/u, "").trim();
					if (!body || !text.includes(body)) return;
					const value = { path: location, hash: createHash("sha256").update(content).digest("hex"), method };
					if (loaded.get(location)?.hash === value.hash) return;
					loaded.set(location, value);
					await callback({ runId: active, ...value });
				} catch {
					/* Observability cannot fail a task or create an invented load. */
				}
			};
			pi.on("tool_result", async (event, context) => {
				if (event.toolName !== "read" || typeof event.input.path !== "string") return;
				if (event.isError) {
					const requested = resolve(context.cwd, event.input.path);
					if (
						basename(requested).toLowerCase() !== "skill.md" ||
						!event.content.some((part) => part.type === "text" && part.text.includes("ENOENT"))
					)
						return;
					const requestedName = basename(dirname(requested));
					const candidates = skillPaths.filter((known) => {
						const name = basename(dirname(known));
						return (
							!pathEquals(known, requested) &&
							(process.platform === "win32"
								? name.toLowerCase() === requestedName.toLowerCase()
								: name === requestedName)
						);
					});
					if (!candidates.length) return;
					return {
						content: [
							...event.content,
							{
								type: "text" as const,
								text: `当前会话已启用的同名技能实际位置：\n${candidates.join("\n")}\n技能可能保存在工作台管理目录。请按此完整路径重新使用 read 读取正文，再按适用条件继续；当前读取仍然失败，路径提示不代表正文已加载，也不改变工具审批。`,
							},
						],
					};
				}
				await recordLoad(
					event.input.path,
					context.cwd,
					"read",
					event.content
						.filter((part) => part.type === "text")
						.map((part) => part.text)
						.join("\n"),
				);
			});
			pi.on("context", async (event, context) => {
				const turn = this.turnContexts.get(sessionId);
				checkpoint = await (turn?.getWorkingCheckpoint ?? getWorkingCheckpoint)?.();
				const userContext = turn?.appendUserContext?.filter((text) => text.trim()) ?? [];
				const inspect = turn?.onModelContext ?? onModelContext;
				const active = this.handles.get(sessionId)?.activeRunId;
				if (active && inspect) {
					if (runId !== active) {
						runId = active;
						request = 0;
					}
					try {
						await inspect({
							runId: active,
							request: ++request,
							systemPrompt: context.getSystemPrompt(),
							workingCheckpoint: checkpoint,
							userContext,
							loadedSkills: loadedRun === active ? [...loaded.values()] : [],
						});
					} catch {
						/* Inspector persistence cannot fail a successful task. */
					}
				}
				const additions = [...(checkpoint ? [checkpoint] : []), ...userContext];
				if (!additions.length) return undefined;
				let userIndex = -1;
				for (let index = 0; index < event.messages.length; index++)
					if (event.messages[index].role === "user") userIndex = index;
				return {
					messages: event.messages.map((message, index) =>
						index !== userIndex || message.role !== "user"
							? message
							: {
									...message,
									content:
										typeof message.content === "string"
											? `${message.content}\n\n${additions.join("\n\n")}`
											: [...message.content, ...additions.map((text) => ({ type: "text" as const, text }))],
								},
					),
				};
			});
			pi.on("before_provider_request", async (event, context) => {
				return adaptThinkingPayload(event.payload, context.model, pi.getThinkingLevel());
			});
			pi.on("before_agent_start", async (event, context) => {
				const skill = parseSkillBlock(event.prompt);
				if (skill) await recordLoad(skill.location, context.cwd, "invocation", skill.content);
				const additions =
					this.turnContexts
						.get(sessionId)
						?.appendSystemPrompt?.map((value) => value.trim())
						.filter(Boolean) ?? [];
				if (skillPaths.length)
					additions.push(
						"技能使用：任务与 available_skills 的描述匹配时，先使用 read 读取对应 location 的完整绝对路径。项目技能可以位于工作台管理目录，不要拼接当前工作目录、skills/ 和技能名称来猜测位置；读取失败时按当前目录或工具返回的位置纠正，不能把未读到正文当作已遵从流程。使用正文时执行其中适用的用户流程约束，包括输出顺序；本轮用户要求和工具权限仍优先。历史中的技能摘录只说明当时版本，当前技能以本轮实际读取的版本为准。",
					);
				if (additions.length === 0) return undefined;
				return { systemPrompt: [event.systemPrompt, ...additions].join("\n\n") };
			});
		};
	}

	private async configureCompaction(session: AgentSession): Promise<void> {
		const model = session.model;
		if (!model) return;
		const policy = (await this.options.getCompactionPolicy?.()) ?? { enabled: true, thresholdPercent: 80 };
		if (!Number.isInteger(policy.thresholdPercent) || policy.thresholdPercent < 10 || policy.thresholdPercent > 95)
			throw new RuntimeError("runtime_failure", "自动压缩阈值必须为 10% 到 95% 的整数");
		const target = Math.ceil((model.contextWindow * policy.thresholdPercent) / 100);
		const previous = session.settingsManager.getCompactionSettings(model);
		session.settingsManager.applyOverrides({
			compaction: {
				enabled: policy.enabled,
				modelOverrides: {
					[`${model.provider}/${model.id}`]: {
						// Pi's threshold is strict >; reserve one additional token to trigger exactly at the target.
						reserveTokens: Math.max(1, model.contextWindow - target + 1),
						keepRecentTokens: Math.min(
							previous.keepRecentTokens,
							Math.max(1, Math.floor(model.contextWindow * 0.16)),
							Math.max(1, Math.floor(target / 2)),
						),
					},
				},
			},
		});
	}

	private resolveModel(reference: RuntimeModelRef): Model<Api> {
		return this.modelCatalog.resolve(reference.provider, reference.modelId);
	}

	private register(
		created: CreatedPiSession,
		kind: RuntimeSessionKind,
		cwd: string,
		referencePath: string,
	): PiSessionHandle {
		const session = created.session;
		const handle: PiSessionHandle = {
			cleanup: created.cleanup,
			terminals: created.terminals,
			session,
			cwd,
			kind,
			status: "idle",
			referencePath,
			abortRequested: false,
			followUp: [],
			queueOpen: false,
			queueMutation: false,
			queueRevision: 0,
			toolLease: created.toolLease,
		};
		this.handles.set(session.sessionId, handle);
		return handle;
	}

	private describe(handle: PiSessionHandle): RuntimeSession {
		const model = handle.session.model;
		return {
			id: handle.session.sessionId,
			runtime: this.id,
			status: handle.status,
			cwd: handle.cwd,
			kind: handle.kind,
			model: model ? { provider: model.provider, modelId: model.id } : undefined,
			thinkingLevel: handle.session.thinkingLevel === "off" ? "none" : handle.session.thinkingLevel,
			reference: {
				runtime: this.id,
				runtimeSessionId: handle.session.sessionId,
				opaque: handle.referencePath,
			},
		};
	}

	private requireHandle(sessionId: string): PiSessionHandle {
		this.assertAvailable();
		const handle = this.handles.get(sessionId);
		if (!handle) throw new RuntimeError("session_not_found", `Unknown Pi session ${sessionId}`);
		return handle;
	}

	private assertAvailable(): void {
		if (this.disposed) throw new RuntimeError("runtime_disposed", "Pi runtime has been disposed");
	}

	private emitPermissionEvent(sessionId: string, event: WorkbenchPermissionEvent): void {
		const active = this.handles.get(sessionId)?.activeStream;
		if (!active || event.runId !== active.adapter.runId) return;
		if (event.type === "permission.requested") {
			active.queue.push(
				active.adapter.create("permission.requested", {
					approvalId: event.approvalId,
					toolCallId: event.toolCallId,
					summary: event.summary,
				}),
			);
		} else {
			active.queue.push(
				active.adapter.create("permission.resolved", {
					approvalId: event.approvalId,
					decision: event.decision,
				}),
			);
		}
	}

	private async validateReferencePath(referencePath: string): Promise<string> {
		const resolvedRoot = await realpath(this.options.sessionDir);
		let resolvedFile: string;
		try {
			resolvedFile = await realpath(referencePath);
		} catch (error) {
			throw new RuntimeError("session_not_found", `Pi session file is unavailable: ${errorMessage(error)}`, {
				cause: error,
			});
		}
		if (!isContained(resolvedRoot, resolvedFile)) {
			throw new RuntimeError("invalid_reference", "Pi session reference is outside the Workbench session directory");
		}
		return resolvedFile;
	}

	private async cleanScreenshotHistory(path: string): Promise<void> {
		if ([...this.handles.values()].some((handle) => pathEquals(handle.referencePath, path))) return;
		let cleanup = this.screenshotHistoryCleanups.get(path);
		if (!cleanup) {
			cleanup = purgeScreenshotHistory(path);
			this.screenshotHistoryCleanups.set(path, cleanup);
		}
		try {
			await cleanup;
		} catch (error) {
			this.screenshotHistoryCleanups.delete(path);
			throw error;
		}
	}
}
