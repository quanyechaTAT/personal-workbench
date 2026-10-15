import type {
	AgentProfile,
	AssistantDraft,
	CapabilityCatalog,
	ChatAttachment,
	ChatCapabilityCatalog,
	ChatSelection,
	ContextAssemblyResult,
	CreateSkillImportRequest,
	CreateSkillRequest,
	DiscoverModelsInput,
	EpisodicMemory,
	KnowledgeDerivedDocument,
	KnowledgeDocument,
	KnowledgeHit,
	KnowledgePassage,
	KnowledgeSearchResult,
	KnowledgeSettings,
	KnowledgeStatus,
	McpConnectionDto,
	McpConnectionTestResult,
	McpToolRecord,
	MemoryEvidence,
	MemoryRetrievalResult,
	ModelSettingsDto,
	PermissionMode,
	ProjectDeletionPreview,
	SaveAgentProfileRequest,
	SaveMcpConnectionRequest,
	SaveModelProviderInput,
	SaveSearchSettingsInput,
	SearchSettingsDto,
	SemanticChange,
	SemanticMemory,
	SkillImport,
	WebSearchResult,
	WorkbenchSkill,
	WorkingCheckpoint,
} from "@earendil-works/workbench-core/contracts";
import type {
	AgentEvent,
	DevelopmentState,
	DiscoveredModelCatalog,
	ModelLoginState,
	RuntimeAuthType,
	RuntimeCommandResult,
	RuntimeInputQueue,
	RuntimeModel,
	RuntimeModelRef,
	RuntimeProviderCatalog,
	RuntimeQueueAction,
	RuntimeSessionCommand,
	RuntimeSlashCommand,
	RuntimeThinkingLevel,
	RuntimeTranscriptMessage,
	SessionUsage,
} from "@earendil-works/workbench-runtime";
import { recordUiEvent } from "./ui-events.ts";

export type {
	AgentProfile,
	AssistantDraft,
	AssistantDraftConfig,
	AssistantMcpToolBinding,
	CapabilityCatalog,
	ChatAttachment,
	ChatCapability,
	CreateSkillImportRequest,
	CreateSkillRequest,
	McpConnectionDto,
	McpConnectionTestResult,
	McpToolRecord,
	ModelProviderDto,
	ModelSettingsDto,
	SaveAgentProfileRequest,
	SaveMcpConnectionRequest,
	SaveModelProviderInput,
	SearchSettingsDto,
	SkillImport,
	WorkbenchSkill,
} from "@earendil-works/workbench-core/contracts";
export type {
	AgentEvent,
	ConfiguredModel,
	RuntimeModel,
	RuntimeSlashCommand,
	RuntimeThinkingLevel,
	RuntimeTranscriptMessage,
} from "@earendil-works/workbench-runtime";

export interface StreamResetEvent {
	type: "stream.reset";
	data: { reason: "buffer_exhausted" };
}

export type AgentStreamEvent = AgentEvent | StreamResetEvent;

export interface Project {
	deletionPending?: boolean;
	id: string;
	slug: string;
	name: string;
	description: string;
	status: "creating" | "active" | "paused" | "completed" | "archived" | "failed";
	workspacePath: string;
	sourcePath?: string;
	defaultProfileId?: string;
	projectFilePath: string;
	memoryFilePath: string;
	createdAt: string;
	updatedAt: string;
}

export interface WorkbenchTask {
	id: string;
	projectId?: string;
	parentId?: string;
	title: string;
	description: string;
	type: "human" | "agent";
	status: "backlog" | "todo" | "running" | "blocked" | "review" | "done" | "failed" | "cancelled";
	priority: number;
	assignedTo: string;
	dueAt?: string;
	createdAt: string;
	updatedAt: string;
	version: number;
	completedAt?: string;
	cleanupRequestedAt?: string;
	execution?: { status: TaskRun["status"]; sessionId?: string; agentRunId?: string };
}

export interface TaskRun {
	id: string;
	taskId: string;
	sessionId?: string;
	agentRunId?: string;
	status: "queued" | "running" | "interrupted" | "review" | "failed" | "cancelled";
	startedAt: string;
	finishedAt?: string;
	summary?: string;
}

export interface WorkbenchSession {
	thinkingLevel?: RuntimeThinkingLevel;
	archivedAt?: string;
	id: string;
	projectId?: string;
	agentProfileId: string;
	title: string;
	kind: "personal" | "project" | "background" | "subagent";
	status: "idle" | "running" | "interrupted" | "unavailable" | "closed";
	model?: { provider: string; modelId: string };
	createdAt: string;
	lastActiveAt: string;
	unavailableReason?: string;
	appliedProfileVersion?: number;
}

export interface ContextSource {
	kind: "instruction" | "identity" | "memory" | "project" | "tasks" | "skill";
	path?: string;
	label: string;
	characters: number;
	truncated: boolean;
}

export interface SessionContext {
	memory?: MemoryRetrievalResult;
	actualMemory?: ContextAssemblyResult;
	knowledge?: KnowledgeSearchResult;
	assistant?: { id: string; name: string; version: number; appliedVersion?: number };
	diagnostics?: Array<{ code: string; message: string }>;
	runtime: { appendSystemPrompt?: string[]; skillPaths?: string[]; toolNames?: string[] };
	sources: ContextSource[];
}

export interface Approval {
	id: string;
	sessionId: string;
	runId: string;
	toolCallId: string;
	toolName: string;
	operation: Record<string, unknown>;
	status: "pending" | "approved" | "denied" | "cancelled" | "expired";
	requestedAt: string;
	expiresAt: string;
}

export interface MemoryCandidate {
	id: string;
	kind: "user" | "global" | "daily" | "project";
	projectId?: string;
	relativePath: string;
	heading?: string;
	proposedText: string;
	reason: string;
	preview: string;
	status: "pending" | "accepted" | "rejected" | "conflicted" | "failed";
	createdAt: string;
}

export interface MemoryFileRecord {
	id: string;
	kind: MemoryCandidate["kind"];
	projectId?: string;
	relativePath: string;
	contentHash: string;
	size: number;
	modifiedAt?: string;
	indexedAt: string;
	version: number;
}

export interface Artifact {
	id: string;
	projectId?: string;
	sessionId?: string;
	type: string;
	name: string;
	relativePath: string;
	mimeType: string;
	size: number;
	sha256: string;
	createdAt: string;
}

export interface ActivityRecord {
	id: string;
	projectId?: string;
	sessionId?: string;
	runId?: string;
	type: string;
	summary: string;
	metadata: Record<string, unknown>;
	createdAt: string;
}

export interface FileEntry {
	name: string;
	path: string;
	type: "directory" | "file";
	size?: number;
	modifiedAt: string;
}

export interface TextFile {
	path: string;
	content: string;
	contentHash: string;
	size: number;
	modifiedAt: string;
}

export interface HomeSummary {
	projects: Project[];
	tasks: WorkbenchTask[];
	sessions: WorkbenchSession[];
	artifacts: Artifact[];
	activity: ActivityRecord[];
}

export interface SettingRecord {
	key: string;
	value: unknown;
	version: number;
	updatedAt?: string;
}

export interface RuntimeInfo {
	runtime: string;
	version: string;
	nodeVersion: string;
	platform: string;
	architecture: string;
	dataRoot: string;
	workspacePath: string;
	statePath: string;
	piSessionsPath: string;
	capabilities: Record<string, boolean>;
}

export interface DiagnosticEvent {
	id: string;
	stage: "raw.pi" | "normalized";
	type: string;
	timestamp: string;
	sessionId?: string;
	runId?: string;
	payload: unknown;
}

export interface LogRecord {
	timestamp: string;
	event: string;
	data?: unknown;
}

export class ApiError extends Error {
	readonly status: number;
	readonly code: string;

	constructor(status: number, code: string, message: string) {
		super(message);
		this.name = "ApiError";
		this.status = status;
		this.code = code;
	}
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
	const response = await fetch(`/api/v1${path}`, {
		...init,
		headers: init?.body ? { "content-type": "application/json", ...init.headers } : init?.headers,
	});
	const value = (await response.json()) as T | { error?: { code?: string; message?: string } };
	if (!response.ok) {
		const error =
			"error" in (value as object) ? (value as { error?: { code?: string; message?: string } }).error : undefined;
		throw new ApiError(
			response.status,
			error?.code ?? "request_failed",
			error?.message ?? `请求失败（${response.status}）`,
		);
	}
	return value as T;
}

function query(values: Record<string, string | undefined>): string {
	const params = new URLSearchParams();
	for (const [key, value] of Object.entries(values)) if (value !== undefined && value !== "") params.set(key, value);
	const encoded = params.toString();
	return encoded ? `?${encoded}` : "";
}

export const api = {
	memoryMaintenance: (run = false) =>
		request<{
			policy: {
				confidenceThreshold: number;
				staleAfterDays: number;
				consolidationIntervalHours: number;
				maxEntryCharacters: number;
			};
			completedAt?: string;
		}>("/memory/maintenance", { method: run ? "POST" : "GET" }),
	sessionWorkspace: (id: string) =>
		request<{ path: string; migrationPath: string; action: "keep" | "delete" | "migrate" }>(
			`/sessions/${encodeURIComponent(id)}/memory/workspace`,
		),
	sessionMemory: (id: string, q = "") =>
		request<{ checkpoint?: WorkingCheckpoint; episodes: EpisodicMemory[]; actual?: ContextAssemblyResult }>(
			`/sessions/${encodeURIComponent(id)}/memory${query({ q })}`,
		),
	memoryEvidence: (id: string, index: number, episodeId?: string) =>
		request<MemoryEvidence>(
			`/sessions/${encodeURIComponent(id)}/memory/evidence${query({ index: String(index), episodeId })}`,
		),
	exportEpisode: (id: string, episodeId: string) =>
		request<{ markdown: string }>(
			`/sessions/${encodeURIComponent(id)}/memory/episodes/${encodeURIComponent(episodeId)}/export`,
		),
	deleteEpisode: (id: string, episodeId: string) =>
		request<{ deleted: true }>(
			`/sessions/${encodeURIComponent(id)}/memory/episodes/${encodeURIComponent(episodeId)}`,
			{ method: "DELETE" },
		),
	semanticMemories: (projectId?: string) =>
		request<SemanticMemory[]>(`/memory/semantic${query({ projectId, history: "true" })}`),
	semanticVersions: (id: string, projectId?: string) =>
		request<SemanticMemory[]>(`/memory/semantic/${encodeURIComponent(id)}/versions${query({ projectId })}`),
	proposeSemantic: (input: {
		kind: "user" | "global" | "project";
		projectId?: string;
		proposedText: string;
		reason: string;
		semanticChange?: SemanticChange;
	}) => request<MemoryCandidate>("/memory/semantic/proposals", { method: "POST", body: JSON.stringify(input) }),
	deleteKnowledgeIndex: (id: string, documentId: string) =>
		request<{ deleted: true }>(
			`/projects/${encodeURIComponent(id)}/knowledge/documents/${encodeURIComponent(documentId)}/index`,
			{ method: "DELETE" },
		),
	home: () => request<HomeSummary>("/home"),
	projects: () => request<Project[]>("/projects"),
	pickProjectDirectory: (signal?: AbortSignal) =>
		request<{ path: string | null }>("/system/pick-project-directory", { method: "POST", signal }),
	pickSkillFile: (signal?: AbortSignal) =>
		request<{ path: string | null; directory: string | null }>("/system/pick-skill-file", { method: "POST", signal }),
	project: (id: string) => request<Project>(`/projects/${encodeURIComponent(id)}`),
	previewProjectDeletion: (id: string) =>
		request<ProjectDeletionPreview>(`/projects/${encodeURIComponent(id)}/deletion-preview`),
	deleteProject: (id: string, expectedFingerprint: string) =>
		request<{ deleted: true }>(`/projects/${encodeURIComponent(id)}`, {
			method: "DELETE",
			body: JSON.stringify({ expectedFingerprint }),
		}),
	knowledgeStatus: (id: string) => request<KnowledgeStatus>(`/projects/${encodeURIComponent(id)}/knowledge`),
	indexKnowledge: (id: string) =>
		request<KnowledgeStatus>(`/projects/${encodeURIComponent(id)}/knowledge/index`, { method: "POST" }),
	searchKnowledge: (id: string, text: string) =>
		request<KnowledgeHit[]>(`/projects/${encodeURIComponent(id)}/knowledge/search${query({ q: text })}`),
	retrieveKnowledge: (id: string, text: string, signal?: AbortSignal) =>
		request<KnowledgeSearchResult>(`/projects/${encodeURIComponent(id)}/knowledge/retrieve${query({ q: text })}`, {
			signal,
		}),
	configureKnowledge: (id: string, settings: KnowledgeSettings) =>
		request<KnowledgeStatus>(`/projects/${encodeURIComponent(id)}/knowledge/settings`, {
			method: "PUT",
			body: JSON.stringify(settings),
		}),
	cancelKnowledgeDocument: (id: string, documentId: string) =>
		request<KnowledgeDocument>(
			`/projects/${encodeURIComponent(id)}/knowledge/documents/${encodeURIComponent(documentId)}/cancel`,
			{ method: "POST" },
		),
	knowledgeDocuments: (id: string) =>
		request<KnowledgeDocument[]>(`/projects/${encodeURIComponent(id)}/knowledge/documents`),
	uploadKnowledge: (id: string, file: File) =>
		request<KnowledgeDocument>(
			`/projects/${encodeURIComponent(id)}/knowledge/documents${query({ name: file.name })}`,
			{ method: "POST", headers: { "content-type": "application/octet-stream" }, body: file },
		),
	retryKnowledgeDocument: (id: string, documentId: string) =>
		request<KnowledgeDocument>(
			`/projects/${encodeURIComponent(id)}/knowledge/documents/${encodeURIComponent(documentId)}/retry`,
			{ method: "POST" },
		),
	deleteKnowledgeDocument: (id: string, documentId: string) =>
		request<{ deleted: true }>(
			`/projects/${encodeURIComponent(id)}/knowledge/documents/${encodeURIComponent(documentId)}`,
			{ method: "DELETE" },
		),
	knowledgePreview: (id: string, documentId: string) =>
		request<{
			descriptionReview?: { fingerprint: string; reviewedAt?: string };
			document: KnowledgeDocument;
			passages: Array<KnowledgePassage & { ordinal: number }>;
			derived?: KnowledgeDerivedDocument;
		}>(`/projects/${encodeURIComponent(id)}/knowledge/documents/${encodeURIComponent(documentId)}/preview`),
	confirmKnowledgeDescription: (id: string, documentId: string, fingerprint: string) =>
		request<KnowledgeDocument>(
			`/projects/${encodeURIComponent(id)}/knowledge/documents/${encodeURIComponent(documentId)}/confirm-description${query({ fingerprint })}`,
			{ method: "POST" },
		),
	createProject: (input: { sourcePath: string }) =>
		request<Project>("/projects", { method: "POST", body: JSON.stringify(input) }),
	tasks: (projectId?: string) => request<WorkbenchTask[]>(`/tasks${query({ projectId })}`),
	createTask: (input: Partial<WorkbenchTask> & { title: string }) =>
		request<WorkbenchTask>("/tasks", { method: "POST", body: JSON.stringify(input) }),
	updateTask: (task: WorkbenchTask, update: Partial<WorkbenchTask>) =>
		request<WorkbenchTask>(`/tasks/${task.id}`, {
			method: "PATCH",
			body: JSON.stringify({ ...update, id: undefined, expectedVersion: task.version }),
		}),
	startTask: (task: WorkbenchTask, profileId: string) =>
		request<{ taskRun: TaskRun; session: WorkbenchSession; runId: string }>(`/tasks/${task.id}/run`, {
			method: "POST",
			body: JSON.stringify({ profileId, expectedVersion: task.version }),
		}),
	previewTaskCleanup: (input: { projectId?: string; completedBefore: string }) =>
		request<{
			tasks: WorkbenchTask[];
			totalTaskCount: number;
			sessionCount: number;
			sessions: Array<{ id: string; title: string }>;
		}>("/tasks/cleanup/preview", { method: "POST", body: JSON.stringify(input) }),
	cleanupTasks: (tasks: WorkbenchTask[], deleteHistory: boolean) =>
		request<{ deletedTasks: number; deletedSessions: number; compacted: boolean }>("/tasks/cleanup", {
			method: "POST",
			body: JSON.stringify({
				tasks: tasks.map((task) => ({ id: task.id, expectedVersion: task.version })),
				deleteHistory,
			}),
		}),
	taskRuns: (id: string) => request<TaskRun[]>(`/tasks/${id}/runs`),
	sessions: (projectId?: string, includeArchived = false) =>
		request<WorkbenchSession[]>(
			`/sessions${query({ projectId, includeArchived: includeArchived ? "true" : undefined })}`,
		),
	sessionAction: (id: string, action: "archive" | "restore" | "delete") =>
		request<WorkbenchSession | { deleted: true }>(
			`/sessions/${encodeURIComponent(id)}${action === "delete" ? "" : `/${action}`}`,
			{ method: action === "delete" ? "DELETE" : "POST" },
		),
	chatCapabilities: (input: { sessionId?: string; profileId?: string; projectId?: string }) =>
		request<ChatCapabilityCatalog>(`/chat-capabilities${query(input)}`),
	createSession: (input: {
		projectId?: string;
		profileId?: string;
		profileSlug?: string;
		title?: string;
		model?: RuntimeModelRef;
		thinkingLevel?: RuntimeThinkingLevel;
	}) => request<WorkbenchSession>("/sessions", { method: "POST", body: JSON.stringify(input) }),
	renameSession: (id: string, title: string, expectedTitle?: string) =>
		request<WorkbenchSession>(`/sessions/${encodeURIComponent(id)}/title`, {
			method: "PUT",
			body: JSON.stringify({ title, expectedTitle }),
		}),
	selectAssistant: (id: string, profileId: string, expectedProfileId: string) =>
		request<WorkbenchSession>(`/sessions/${encodeURIComponent(id)}/assistant`, {
			method: "PUT",
			body: JSON.stringify({ profileId, expectedProfileId }),
		}),
	permissionMode: (sessionId: string) =>
		request<{ mode: PermissionMode }>(`/sessions/${encodeURIComponent(sessionId)}/permission-mode`),
	setPermissionMode: (sessionId: string, mode: PermissionMode) =>
		request<{ mode: PermissionMode }>(`/sessions/${encodeURIComponent(sessionId)}/permission-mode`, {
			method: "PUT",
			body: JSON.stringify({ mode }),
		}),
	transcript: (id: string) => request<RuntimeTranscriptMessage[]>(`/sessions/${id}/transcript`),
	previewSessionFile: (id: string, path: string) =>
		request<TextFile>(`/sessions/${encodeURIComponent(id)}/file-preview${query({ path })}`),
	sessionState: (id: string) =>
		request<{
			activeRunId: string | null;
			development?: DevelopmentState;
			usage?: SessionUsage;
			inputQueue?: RuntimeInputQueue;
		}>(`/sessions/${id}/runtime-state`),
	rebuildEpisodeVectors: (id: string) =>
		request<{ indexed: number }>(`/sessions/${encodeURIComponent(id)}/memory/rebuild`, { method: "POST" }),
	rebuildSemanticVectors: (projectId?: string) =>
		request<{ indexed: number }>(`/memory/semantic/rebuild${query({ projectId })}`, { method: "POST" }),
	cleanupCheckpoints: () => request<{ deleted: number }>("/memory/cleanup", { method: "POST" }),
	commands: () => request<RuntimeSlashCommand[]>("/runtime/commands"),
	sessionCommand: (id: string, command: RuntimeSessionCommand, signal?: AbortSignal) =>
		request<RuntimeCommandResult>(`/sessions/${encodeURIComponent(id)}/commands`, {
			method: "POST",
			body: JSON.stringify(command),
			signal,
		}),
	reloadSession: (id: string) =>
		request<WorkbenchSession>(`/sessions/${encodeURIComponent(id)}/resume`, { method: "POST" }),
	context: (id: string) => request<SessionContext>(`/sessions/${id}/context`),
	uploadChatAttachment: (id: string, file: File, signal?: AbortSignal) =>
		request<ChatAttachment>(`/sessions/${encodeURIComponent(id)}/attachments${query({ name: file.name })}`, {
			method: "POST",
			headers: { "content-type": "application/octet-stream" },
			body: file,
			signal,
		}),
	removeChatAttachment: (id: string, attachmentId: string) =>
		request<{ deleted: true }>(
			`/sessions/${encodeURIComponent(id)}/attachments/${encodeURIComponent(attachmentId)}`,
			{ method: "DELETE" },
		),
	startMessage: (
		id: string,
		text: string,
		selection?: ChatSelection,
		attachmentIds?: string[],
		signal?: AbortSignal,
	) =>
		request<{ runId: string }>(`/sessions/${id}/messages`, {
			method: "POST",
			body: JSON.stringify({ text, selection, attachmentIds }),
			signal,
		}),
	steerMessage: (id: string, runId: string, text: string) =>
		request<{ runId: string }>(`/sessions/${encodeURIComponent(id)}/steer`, {
			method: "POST",
			body: JSON.stringify({ runId, text }),
		}),
	queueMessage: (id: string, runId: string, text: string) =>
		request<RuntimeInputQueue>(`/sessions/${encodeURIComponent(id)}/queue`, {
			method: "POST",
			body: JSON.stringify({ runId, text }),
		}),
	updateQueuedMessage: (id: string, runId: string, itemId: string, action: RuntimeQueueAction) =>
		request<RuntimeInputQueue>(`/sessions/${encodeURIComponent(id)}/queue/${encodeURIComponent(itemId)}`, {
			method: "PATCH",
			body: JSON.stringify({ runId, action }),
		}),
	abort: (id: string) => request<{ status: string }>(`/sessions/${id}/abort`, { method: "POST" }),
	selectModel: (id: string, model: { provider: string; modelId: string }) =>
		request<WorkbenchSession>(`/sessions/${id}/model`, { method: "PUT", body: JSON.stringify(model) }),
	selectThinking: (id: string, level: RuntimeThinkingLevel) =>
		request<WorkbenchSession>(`/sessions/${id}/thinking`, { method: "PUT", body: JSON.stringify({ level }) }),
	modelSettings: () => request<ModelSettingsDto>("/models/providers"),
	modelCandidates: () => request<RuntimeProviderCatalog[]>("/models/candidates"),
	startModelLogin: (providerId: string, authType: RuntimeAuthType) =>
		request<ModelLoginState>("/models/logins", { method: "POST", body: JSON.stringify({ providerId, authType }) }),
	modelLogin: (id: string) => request<ModelLoginState>(`/models/logins/${encodeURIComponent(id)}`),
	answerModelLogin: (id: string, promptId: string, value: string) =>
		request<ModelLoginState>(`/models/logins/${encodeURIComponent(id)}/answer`, {
			method: "POST",
			body: JSON.stringify({ promptId, value }),
		}),
	cancelModelLogin: (id: string) =>
		request<ModelLoginState>(`/models/logins/${encodeURIComponent(id)}`, { method: "DELETE" }),
	discoverModels: (input: DiscoverModelsInput) =>
		request<DiscoveredModelCatalog>("/models/discover", { method: "POST", body: JSON.stringify(input) }),
	saveModelProvider: (id: string | undefined, input: SaveModelProviderInput) =>
		request<ModelSettingsDto>(`/models/providers${id ? `/${encodeURIComponent(id)}` : ""}`, {
			method: id ? "PUT" : "POST",
			body: JSON.stringify(input),
		}),
	importModelProvider: (providerId: string, expectedVersion: number) =>
		request<ModelSettingsDto>("/models/import", {
			method: "POST",
			body: JSON.stringify({ providerId, expectedVersion }),
		}),
	removeModelProvider: (id: string, expectedVersion: number) =>
		request<ModelSettingsDto>(`/models/providers/${encodeURIComponent(id)}`, {
			method: "DELETE",
			body: JSON.stringify({ expectedVersion }),
		}),
	searchSettings: () => request<SearchSettingsDto>("/search/settings"),
	saveSearchSettings: (input: SaveSearchSettingsInput) =>
		request<SearchSettingsDto>("/search/settings", { method: "PUT", body: JSON.stringify(input) }),
	testSearch: (query: string) =>
		request<WebSearchResult>("/search/test", { method: "POST", body: JSON.stringify({ query }) }),
	profiles: () => request<AgentProfile[]>("/profiles"),
	allProfiles: () => request<AgentProfile[]>("/profiles?includeArchived=true"),
	profile: (id: string) => request<AgentProfile>(`/profiles/${encodeURIComponent(id)}`),
	createProfile: (input: SaveAgentProfileRequest) =>
		request<AgentProfile>("/profiles", { method: "POST", body: JSON.stringify(input) }),
	updateProfile: (id: string, input: SaveAgentProfileRequest, expectedVersion: number) =>
		request<AgentProfile>(`/profiles/${encodeURIComponent(id)}`, {
			method: "PUT",
			body: JSON.stringify({ ...input, expectedVersion }),
		}),
	cloneProfile: (id: string) =>
		request<AgentProfile>(`/profiles/${encodeURIComponent(id)}/clone`, { method: "POST", body: "{}" }),
	profileStatus: (profile: AgentProfile, action: "archive" | "restore") =>
		request<AgentProfile>(`/profiles/${encodeURIComponent(profile.id)}/${action}`, {
			method: "POST",
			body: JSON.stringify({ expectedVersion: profile.version }),
		}),
	deleteProfile: (profile: AgentProfile) =>
		request<{ deleted: true }>(`/profiles/${encodeURIComponent(profile.id)}`, {
			method: "DELETE",
			body: JSON.stringify({ expectedVersion: profile.version }),
		}),
	capabilities: (projectId?: string) => request<CapabilityCatalog>(`/capabilities${query({ projectId })}`),
	connections: () => request<McpConnectionDto[]>("/mcp/connections"),
	createConnection: (input: SaveMcpConnectionRequest) =>
		request<McpConnectionDto>("/mcp/connections", { method: "POST", body: JSON.stringify(input) }),
	updateConnection: (id: string, input: SaveMcpConnectionRequest, expectedVersion: number) =>
		request<McpConnectionDto>(`/mcp/connections/${encodeURIComponent(id)}`, {
			method: "PUT",
			body: JSON.stringify({ ...input, expectedVersion }),
		}),
	testConnection: (id: string) =>
		request<McpConnectionTestResult>(`/mcp/connections/${encodeURIComponent(id)}/test`, { method: "POST" }),
	connectionTools: (id: string) => request<McpToolRecord[]>(`/mcp/connections/${encodeURIComponent(id)}/tools`),
	toggleConnection: (connection: McpConnectionDto) =>
		request<McpConnectionDto>(`/mcp/connections/${encodeURIComponent(connection.id)}/enabled`, {
			method: "PATCH",
			body: JSON.stringify({ enabled: !connection.enabled, expectedVersion: connection.version }),
		}),
	authorizeConnection: (id: string) =>
		request<{ authorizationUrl?: string; status: string }>(`/mcp/connections/${encodeURIComponent(id)}/authorize`, {
			method: "POST",
		}),
	disconnectAuthorization: (id: string) =>
		request<{ disconnected: boolean }>(`/mcp/connections/${encodeURIComponent(id)}/authorization`, {
			method: "DELETE",
		}),
	startDraft: (requirement: string, model?: { provider: string; modelId: string }) =>
		request<{ draft: AssistantDraft; queued: boolean }>("/assistant-drafts", {
			method: "POST",
			body: JSON.stringify({ requirement, model }),
		}),
	draft: (id: string) => request<AssistantDraft>(`/assistant-drafts/${encodeURIComponent(id)}`),
	saveDraft: (draft: AssistantDraft, config: SaveAgentProfileRequest) =>
		request<AssistantDraft>(`/assistant-drafts/${encodeURIComponent(draft.id)}`, {
			method: "PUT",
			body: JSON.stringify({ expectedVersion: draft.version, config }),
		}),
	createDraftProfile: (id: string) =>
		request<AssistantDraft>(`/assistant-drafts/${encodeURIComponent(id)}/create-profile`, { method: "POST" }),
	cancelDraft: (id: string) =>
		request<AssistantDraft>(`/assistant-drafts/${encodeURIComponent(id)}/cancel`, { method: "POST" }),
	models: () => request<{ capabilities: Record<string, boolean>; models: RuntimeModel[] }>("/runtime/models"),
	runtimeInfo: () => request<RuntimeInfo>("/runtime/info"),
	diagnosticEvents: (stage?: "raw.pi" | "normalized") =>
		request<DiagnosticEvent[]>(`/developer/events${query({ stage })}`),
	logs: () => request<LogRecord[]>("/developer/logs"),
	approvals: () => request<Approval[]>("/approvals"),
	resolveApproval: (id: string, decision: "approved" | "denied" | "cancelled") =>
		request<Approval>(`/approvals/${id}/resolve`, { method: "POST", body: JSON.stringify({ decision }) }),
	candidates: () => request<MemoryCandidate[]>("/memory/candidates"),
	memoryFiles: () => request<MemoryFileRecord[]>("/memory/files"),
	memoryFile: (path: string) => request<TextFile>(`/memory/file${query({ path })}`),
	proposeMemory: (input: {
		kind: MemoryCandidate["kind"];
		projectId?: string;
		proposedText: string;
		reason: string;
		heading?: string;
	}) => request<MemoryCandidate>("/memory/candidates", { method: "POST", body: JSON.stringify(input) }),
	resolveCandidate: (id: string, decision: "accept" | "reject") =>
		request<MemoryCandidate>(`/memory/candidates/${id}/${decision}`, { method: "POST" }),
	editMemory: (input: {
		path: string;
		content: string;
		expectedHash: string;
		kind: MemoryCandidate["kind"];
		projectId?: string;
	}) => request<{ contentHash: string }>("/memory/file", { method: "PUT", body: JSON.stringify(input) }),
	deleteMemory: (input: { path: string; kind: MemoryCandidate["kind"]; projectId?: string }) =>
		request<{ deleted: true }>("/memory/file", { method: "DELETE", body: JSON.stringify(input) }),
	memorySearch: (q: string, projectId?: string) =>
		request<Array<{ memoryId: string; relativePath: string; startLine: number; endLine: number; snippet: string }>>(
			`/memory/search${query({ q, projectId })}`,
		),
	skills: (projectId?: string) => request<WorkbenchSkill[]>(`/skills${query({ projectId })}`),
	createSkill: (input: CreateSkillRequest) =>
		request<WorkbenchSkill>("/skills", { method: "POST", body: JSON.stringify(input) }),
	skillContent: (id: string) =>
		request<{ content: string; hash: string }>(`/skills/${encodeURIComponent(id)}/content`),
	saveSkillContent: (id: string, content: string, expectedHash: string) =>
		request<WorkbenchSkill>(`/skills/${encodeURIComponent(id)}/content`, {
			method: "PUT",
			body: JSON.stringify({ content, expectedHash }),
		}),
	previewSkillImport: (input: CreateSkillImportRequest) =>
		request<SkillImport>("/skills/imports", { method: "POST", body: JSON.stringify(input) }),
	commitSkillImport: (id: string, slugs: string[]) =>
		request<{ import: SkillImport; skills: WorkbenchSkill[] }>(`/skills/imports/${encodeURIComponent(id)}/commit`, {
			method: "POST",
			body: JSON.stringify({ slugs }),
		}),
	discardSkillImport: (id: string) =>
		request<SkillImport>(`/skills/imports/${encodeURIComponent(id)}`, { method: "DELETE" }),
	previewSkillUpdate: (id: string) =>
		request<SkillImport>(`/skills/${encodeURIComponent(id)}/preview-update`, { method: "POST" }),
	skillImportFile: (id: string, slug: string, path: string) =>
		request<{ before?: string; after?: string }>(
			`/skills/imports/${encodeURIComponent(id)}/file${query({ slug, path })}`,
		),
	toggleSkill: (id: string, enabled: boolean) =>
		request<WorkbenchSkill>(`/skills/${id}`, { method: "PATCH", body: JSON.stringify({ enabled }) }),
	artifacts: (projectId?: string) => request<Artifact[]>(`/artifacts${query({ projectId })}`),
	files: (path = "") => request<FileEntry[]>(`/files/list${query({ path })}`),
	projectFiles: (id: string, path = "") =>
		request<FileEntry[]>(`/projects/${encodeURIComponent(id)}/files/list${query({ path })}`),
	projectFile: (id: string, path: string) =>
		request<TextFile>(`/projects/${encodeURIComponent(id)}/files/read${query({ path })}`),
	writeProjectFile: (id: string, path: string, content: string, expectedHash?: string) =>
		request<TextFile>(`/projects/${encodeURIComponent(id)}/files/write`, {
			method: "PUT",
			body: JSON.stringify({ path, content, expectedHash }),
		}),
	file: (path: string) => request<TextFile>(`/files/read${query({ path })}`),
	writeFile: (path: string, content: string, expectedHash?: string) =>
		request<TextFile>("/files/write", { method: "PUT", body: JSON.stringify({ path, content, expectedHash }) }),
	settings: () => request<SettingRecord[]>("/settings"),
	setSetting: (key: string, value: unknown, expectedVersion?: number) =>
		request<SettingRecord>(`/settings/${encodeURIComponent(key)}`, {
			method: "PUT",
			body: JSON.stringify({ value, expectedVersion }),
		}),
};

const EVENT_NAMES = [
	"run.started",
	"run.completed",
	"run.aborted",
	"run.failed",
	"input.queue",
	"development.updated",
	"usage.updated",
	"message.started",
	"message.text.delta",
	"message.reasoning.delta",
	"message.completed",
	"tool.started",
	"tool.updated",
	"tool.completed",
	"permission.requested",
	"permission.resolved",
	"artifact.created",
	"agent.status",
	"stream.reset",
] as const;

export function streamRun(
	runId: string,
	onEvent: (event: AgentStreamEvent) => void,
	onError: (message: string) => void,
): () => void {
	const source = new EventSource(`/api/v1/runs/${encodeURIComponent(runId)}/events`);
	for (const name of EVENT_NAMES) {
		source.addEventListener(name, (raw) => {
			try {
				const event = JSON.parse((raw as MessageEvent<string>).data) as AgentStreamEvent;
				recordUiEvent(event);
				onEvent(event);
				if (name === "run.completed" || name === "run.aborted" || name === "run.failed") source.close();
			} catch (error) {
				onError(error instanceof Error ? error.message : String(error));
				source.close();
			}
		});
	}
	source.onerror = () => {
		if (source.readyState === EventSource.CLOSED) onError("助手事件连接已关闭。请重新打开会话恢复状态。");
	};
	return () => source.close();
}
