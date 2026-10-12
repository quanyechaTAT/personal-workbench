import type { RuntimeThinkingLevel } from "@earendil-works/workbench-runtime";
import type { SemanticChange } from "./semantic-memory.ts";

export type ProjectStatus = "creating" | "active" | "paused" | "completed" | "archived" | "failed";

export interface Project {
	id: string;
	slug: string;
	name: string;
	description: string;
	status: ProjectStatus;
	workspacePath: string;
	sourcePath?: string;
	defaultProfileId?: string;
	projectFilePath: string;
	memoryFilePath: string;
	createdAt: string;
	updatedAt: string;
	archivedAt?: string;
}

export type TaskType = "human" | "agent";
export type TaskStatus = "backlog" | "todo" | "running" | "blocked" | "review" | "done" | "failed" | "cancelled";

export interface WorkbenchTask {
	id: string;
	projectId?: string;
	parentId?: string;
	title: string;
	description: string;
	type: TaskType;
	status: TaskStatus;
	priority: number;
	assignedTo: string;
	dueAt?: string;
	createdAt: string;
	updatedAt: string;
	completedAt?: string;
	version: number;
	cleanupRequestedAt?: string;
	cleanupDeleteHistory?: boolean;
	execution?: { status: TaskRunStatus; sessionId?: string; agentRunId?: string };
}

export interface TaskCleanupSelection {
	id: string;
	expectedVersion: number;
}

export type TaskRunStatus = "queued" | "running" | "interrupted" | "review" | "failed" | "cancelled";

export interface TaskRun {
	id: string;
	taskId: string;
	sessionId?: string;
	agentRunId?: string;
	status: TaskRunStatus;
	startedAt: string;
	finishedAt?: string;
	errorCode?: string;
	summary?: string;
	createdAt: string;
}

export type MemoryKind = "user" | "global" | "daily" | "project";
export type MemoryCandidateStatus = "pending" | "accepted" | "rejected" | "conflicted" | "failed";

export interface MemoryFileRecord {
	id: string;
	kind: MemoryKind;
	projectId?: string;
	relativePath: string;
	contentHash: string;
	size: number;
	modifiedAt?: string;
	indexedAt: string;
	version: number;
}

export interface MemoryIndexEntry {
	id: string;
	memoryFileId: string;
	projectId?: string;
	kind: MemoryKind;
	heading?: string;
	startLine: number;
	endLine: number;
	content: string;
	contentHash: string;
	occurredOn?: string;
	createdAt: string;
}

export interface MemoryCandidate {
	semanticChange?: SemanticChange;
	id: string;
	kind: MemoryKind;
	projectId?: string;
	relativePath: string;
	heading?: string;
	proposedText: string;
	reason: string;
	preview: string;
	baseHash: string;
	appliedHash?: string;
	status: MemoryCandidateStatus;
	sessionId?: string;
	runId?: string;
	toolCallId?: string;
	idempotencyKey?: string;
	createdAt: string;
	updatedAt: string;
	resolvedAt?: string;
}

export interface MemorySearchResult {
	memoryId: string;
	kind: MemoryKind;
	projectId?: string;
	relativePath: string;
	startLine: number;
	endLine: number;
	heading?: string;
	snippet: string;
	contentHash: string;
	score: number;
}

export type ArtifactType = "document" | "report" | "code" | "analysis" | "dataset" | "export" | "other";

export interface Artifact {
	id: string;
	projectId?: string;
	sessionId?: string;
	taskRunId?: string;
	type: ArtifactType;
	name: string;
	filePath: string;
	relativePath: string;
	mimeType: string;
	size: number;
	sha256: string;
	toolCallId?: string;
	idempotencyKey?: string;
	createdAt: string;
}

export type SkillScope = "global" | "project";
export type SkillSourceKind = "builtin" | "local" | "git" | "workspace";

export interface WorkbenchSkill {
	id: string;
	slug: string;
	name: string;
	description: string;
	scope: SkillScope;
	projectId?: string;
	enabled: boolean;
	path: string;
	sourceHash: string;
	importedHash?: string;
	isBuiltin: boolean;
	sourceKind: SkillSourceKind;
	sourceUrl?: string;
	sourceRef?: string;
	sourceCommit?: string;
	sourceSubdirectory?: string;
	diagnostics: string[];
	createdAt: string;
	updatedAt: string;
}

export type ApprovalStatus = "pending" | "approved" | "denied" | "cancelled" | "expired";

export interface Approval {
	id: string;
	sessionId: string;
	runId: string;
	toolCallId: string;
	toolName: string;
	operation: Record<string, unknown>;
	status: ApprovalStatus;
	requestedAt: string;
	expiresAt: string;
	resolvedAt?: string;
}

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface SettingRecord {
	key: string;
	value: JsonValue;
	version: number;
	updatedAt: string;
}

export type WorkbenchSessionKind = "personal" | "project" | "background" | "subagent";
export type WorkbenchSessionStatus = "idle" | "running" | "interrupted" | "unavailable" | "closed";

export type AgentProfileStatus = "active" | "archived";
export type ToolApprovalMode = "ask" | "allow";

export interface AssistantMcpToolBinding {
	connectionId: string;
	toolName: string;
	approvedDefinitionHash: string;
	approval: ToolApprovalMode;
}

export interface AgentProfile {
	deletedAt?: string;
	id: string;
	slug: string;
	name: string;
	description: string;
	systemPrompt: string;
	defaultModel?: { provider: string; modelId: string };
	tools: string[];
	skillIds: string[];
	mcpBindings: AssistantMcpToolBinding[];
	bindingDiagnostics?: string[];
	status: AgentProfileStatus;
	version: number;
	isBuiltin: boolean;
	createdAt: string;
	updatedAt: string;
}

export interface AgentProfileRevision {
	profileId: string;
	version: number;
	config: AgentProfile;
	createdAt: string;
}

export type McpTransportKind = "stdio" | "streamable-http" | "sse";
export type McpAuthKind = "none" | "headers" | "oauth";

export interface McpStdioConfig {
	command: string;
	args: string[];
	cwd?: string;
	environmentKeys: string[];
}

export interface McpRemoteConfig {
	url: string;
	headerNames: string[];
	clientId?: string;
}

export interface McpConnection {
	callTimeoutMs?: number;
	id: string;
	name: string;
	transport: McpTransportKind;
	stdio?: McpStdioConfig;
	remote?: McpRemoteConfig;
	authKind: McpAuthKind;
	secretRef?: string;
	enabled: boolean;
	version: number;
	lastConnectedAt?: string;
	lastError?: string;
	createdAt: string;
	updatedAt: string;
}

export interface McpToolRecord {
	diagnostic?: string;
	connectionId: string;
	name: string;
	title?: string;
	description: string;
	inputSchema: Record<string, unknown>;
	definitionHash: string;
	readOnlyHint?: boolean;
	destructiveHint?: boolean;
	discoveredAt: string;
}

export type SkillImportSource = "local" | "git";
export type SkillImportStatus = "preview" | "committed" | "discarded" | "failed";

export interface SkillImportCandidate {
	slug: string;
	name: string;
	description: string;
	relativePath: string;
	files: string[];
	diagnostics: string[];
	contentHash?: string;
	update?: {
		skillId: string;
		expectedHash: string;
		changes: Array<{ path: string; kind: "added" | "changed" | "removed" }>;
	};
}

export interface SkillImport {
	id: string;
	source: SkillImportSource;
	sourceLocation: string;
	sourceRef?: string;
	sourceCommit?: string;
	sourceSubdirectory?: string;
	scope: SkillScope;
	projectId?: string;
	stagingPath: string;
	candidates: SkillImportCandidate[];
	status: SkillImportStatus;
	errorMessage?: string;
	createdAt: string;
	updatedAt: string;
}

export type AssistantDraftStatus = "generating" | "ready" | "failed" | "cancelled" | "created";

export interface AssistantDraftConfig {
	name: string;
	description: string;
	systemPrompt: string;
	defaultModel?: { provider: string; modelId: string };
	tools: string[];
	skillIds: string[];
	mcpBindings: AssistantMcpToolBinding[];
}

export interface AssistantDraft {
	id: string;
	requirement: string;
	status: AssistantDraftStatus;
	config?: AssistantDraftConfig;
	model?: { provider: string; modelId: string };
	errorMessage?: string;
	version: number;
	createdProfileId?: string;
	createdAt: string;
	updatedAt: string;
}

export interface WorkbenchSession {
	thinkingLevel?: RuntimeThinkingLevel;
	archivedAt?: string;
	deletionRequestedAt?: string;
	modelOverride?: { provider: string; modelId: string };
	id: string;
	runtime: string;
	runtimeSessionId: string;
	runtimeRef: string;
	projectId?: string;
	agentProfileId: string;
	title: string;
	kind: WorkbenchSessionKind;
	status: WorkbenchSessionStatus;
	cwd: string;
	model?: { provider: string; modelId: string };
	appliedProfileVersion?: number;
	configurationFingerprint?: string;
	createdAt: string;
	updatedAt: string;
	lastActiveAt: string;
	closedAt?: string;
	unavailableReason?: string;
}

export type AgentRunStatus = "running" | "completed" | "aborted" | "failed" | "interrupted";

export interface AgentRun {
	id: string;
	sessionId: string;
	taskRunId?: string;
	status: AgentRunStatus;
	inputMessageId: string;
	finalMessageId?: string;
	profileSlug: string;
	profileVersion?: number;
	capabilities?: JsonValue;
	model?: { provider: string; modelId: string };
	startedAt: string;
	settledAt?: string;
	errorCode?: string;
	errorMessage?: string;
}

export interface ActivityRecord {
	id: string;
	projectId?: string;
	sessionId?: string;
	runId?: string;
	type: string;
	summary: string;
	metadata: Record<string, JsonValue>;
	createdAt: string;
}
