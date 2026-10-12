import type { RuntimeCommandResult, RuntimeSessionCommand, RuntimeSlashCommand } from "./commands.ts";
import type { DevelopmentState } from "./development.ts";
import type { AgentEvent, RuntimeUsage } from "./events.ts";
import type { RuntimeModelCatalog, RuntimeThinkingLevel } from "./models.ts";
import type { RuntimeSandboxPolicy } from "./sandbox.ts";
import type { RuntimeToolBinding, RuntimeToolScope } from "./tools.ts";
import type { SessionUsage } from "./usage.ts";
import type { RuntimeWebSearch } from "./web-search.ts";

export type RuntimeSessionKind = "personal" | "project" | "background" | "subagent";
export type RuntimeSessionStatus = "idle" | "running" | "aborting" | "unavailable";

export interface RuntimeModelRef {
	provider: string;
	modelId: string;
}

export interface RuntimeModel extends RuntimeModelRef {
	name: string;
	providerName?: string;
	available: boolean;
	reasoning: boolean;
	vision?: boolean;
	contextWindow: number;
	maxTokens: number;
	thinkingLevels?: RuntimeThinkingLevel[];
}

export interface RuntimeCapabilities {
	abort: boolean;
	steering: boolean;
	modelSelection: boolean;
	persistentSessions: boolean;
	reasoningStream: boolean;
	resume: boolean;
	toolStream: boolean;
}

export interface RuntimeContextOptions {
	onSkillLoaded?(value: { runId: string; path: string; hash: string; method: "invocation" | "read" }): Promise<void>;
	/** Public request boundary, without credentials, tool parameters or hidden reasoning. */
	onModelContext?(value: {
		runId: string;
		request: number;
		systemPrompt: string;
		workingCheckpoint?: string;
		userContext?: string[];
		loadedSkills?: Array<{ path: string; hash: string; method: "invocation" | "read" }>;
	}): Promise<void>;
	/** Application-owned compact state, read through public extension boundaries. */
	getWorkingCheckpoint?(): Promise<string | undefined>;
	sandbox?: RuntimeSandboxPolicy;
	minimal?: boolean;
	systemPrompt?: string;
	appendSystemPrompt?: string[];
	skillPaths?: string[];
	toolNames?: string[];
	toolScope?: RuntimeToolScope;
	toolBindings?: RuntimeToolBinding[];
}

export interface RuntimeSessionReference {
	runtime: string;
	runtimeSessionId: string;
	opaque: string;
}

export interface RuntimeSession {
	id: string;
	runtime: string;
	status: RuntimeSessionStatus;
	cwd: string;
	kind: RuntimeSessionKind;
	model?: RuntimeModelRef;
	thinkingLevel?: RuntimeThinkingLevel;
	reference: RuntimeSessionReference;
}

export interface CreateRuntimeSessionOptions {
	id?: string;
	cwd: string;
	kind: RuntimeSessionKind;
	model?: RuntimeModelRef;
	context?: RuntimeContextOptions;
}

export interface ResumeRuntimeSessionOptions {
	model?: RuntimeModelRef;
	reference: RuntimeSessionReference;
	expectedCwd?: string;
	kind: RuntimeSessionKind;
	context?: RuntimeContextOptions;
}

export interface RuntimeInput {
	id: string;
	text: string;
	images?: RuntimeInputImage[];
	attachments?: RuntimeAttachmentReference[];
	attachmentText?: string;
}

export interface RuntimeInputImage {
	type: "image";
	data: string;
	mimeType: string;
}

/** File references only. Pi JSONL remains the sole persisted conversation. */
export interface RuntimeAttachmentReference {
	id: string;
	name: string;
	mimeType: string;
	size: number;
	sha256: string;
	truncated: boolean;
	diagnostics: string[];
}

export interface RuntimeQueuedMessage {
	id: string;
	text: string;
}

export interface RuntimeInputQueue {
	revision: number;
	steering: string[];
	followUp: RuntimeQueuedMessage[];
}

export type RuntimeQueueAction = { kind: "edit"; text: string } | { kind: "remove" } | { kind: "steer" };

export interface RuntimeTurnContext {
	onSkillLoaded?: RuntimeContextOptions["onSkillLoaded"];
	getWorkingCheckpoint?: RuntimeContextOptions["getWorkingCheckpoint"];
	onModelContext?: RuntimeContextOptions["onModelContext"];
	appendSystemPrompt?: string[];
	/** Transient user-owned requirements; added at context events, never to Pi JSONL. */
	appendUserContext?: string[];
}

export interface SendMessageOptions {
	runId: string;
	signal?: AbortSignal;
	context?: RuntimeTurnContext;
}

export interface RuntimeTranscriptContent {
	data?: string;
	mimeType?: string;
	skillName?: string;
	toolLabel?: string;
	type: "text" | "reasoning" | "tool-call" | "image" | "skill";
	text?: string;
	toolCallId?: string;
	toolName?: string;
	arguments?: unknown;
}

export interface RuntimeTranscriptMessage {
	attachments?: RuntimeAttachmentReference[];
	/** Stable Pi SessionManager entry ID; legacy display ID is retained separately. */
	piEntryId?: string;
	/** Evidence representation excludes PTC parameters while display content remains complete. */
	evidenceText?: string;
	toolResults?: Array<{ toolCallId: string; toolName: string; text: string; isError: boolean }>;
	usage?: RuntimeUsage;
	toolLabel?: string;
	errorMessage?: string;
	id: string;
	role: "user" | "assistant" | "tool";
	content: RuntimeTranscriptContent[];
	timestamp: string;
	toolCallId?: string;
	toolName?: string;
	isError?: boolean;
}

export interface RuntimeSessionFilter {
	cwd?: string;
	status?: RuntimeSessionStatus;
}

export interface AgentRuntime {
	readonly id: string;
	readonly modelCatalog?: RuntimeModelCatalog;
	readonly webSearch?: RuntimeWebSearch;
	listCommands?(): readonly RuntimeSlashCommand[];
	executeSessionCommand?(
		sessionId: string,
		command: RuntimeSessionCommand,
		signal?: AbortSignal,
	): Promise<RuntimeCommandResult>;
	createSession(options: CreateRuntimeSessionOptions): Promise<RuntimeSession>;
	resumeSession(options: ResumeRuntimeSessionOptions): Promise<RuntimeSession>;
	sendMessage(sessionId: string, input: RuntimeInput, options: SendMessageOptions): AsyncIterable<AgentEvent>;
	steerMessage?(sessionId: string, text: string, runId: string): Promise<void>;
	queueMessage?(sessionId: string, text: string, runId: string): Promise<RuntimeInputQueue>;
	updateQueuedMessage?(
		sessionId: string,
		itemId: string,
		action: RuntimeQueueAction,
		runId: string,
	): Promise<RuntimeInputQueue>;
	readInputQueue?(sessionId: string): RuntimeInputQueue;
	/** Isolated metadata completion; does not add a turn, use tools or mutate conversation context. */
	generateSessionTitle?(sessionId: string, prompt: string, signal: AbortSignal): Promise<string | undefined>;
	/** A tool-free Pi SDK completion; never appends messages to a conversation. */
	generateKnowledgeQueries?(prompt: string, signal: AbortSignal, model?: RuntimeModelRef): Promise<string | undefined>;
	/** Isolated HyDE generation using the selected conversation model; no tools or session mutations. */
	generateKnowledgeHypothesis?(
		prompt: string,
		signal: AbortSignal,
		model?: RuntimeModelRef,
	): Promise<string | undefined>;
	abort(sessionId: string): Promise<void>;
	getSession(sessionId: string): Promise<RuntimeSession>;
	listSessions(filter?: RuntimeSessionFilter): Promise<RuntimeSession[]>;
	readTranscript(sessionId: string): Promise<RuntimeTranscriptMessage[]>;
	readTranscriptReference(options: ResumeRuntimeSessionOptions): Promise<RuntimeTranscriptMessage[]>;
	readDevelopmentState?(options: ResumeRuntimeSessionOptions): Promise<DevelopmentState | undefined>;
	readUsage?(options: ResumeRuntimeSessionOptions): Promise<SessionUsage>;
	getCapabilities(): RuntimeCapabilities;
	listModels(): Promise<RuntimeModel[]>;
	selectModel(sessionId: string, model: RuntimeModelRef): Promise<void>;
	selectThinkingLevel?(sessionId: string, level: RuntimeThinkingLevel): Promise<RuntimeThinkingLevel>;
	releaseSession(sessionId: string): Promise<void>;
	deleteSessionReference(options: ResumeRuntimeSessionOptions): Promise<void>;
	dispose(): Promise<void>;
}
