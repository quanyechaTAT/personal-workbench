import type {
	ActivityRecord,
	AgentProfile,
	AgentProfileRevision,
	AgentRun,
	Approval,
	ApprovalStatus,
	Artifact,
	AssistantDraft,
	AssistantDraftStatus,
	McpConnection,
	McpToolRecord,
	MemoryCandidate,
	MemoryCandidateStatus,
	MemoryFileRecord,
	MemoryIndexEntry,
	MemoryKind,
	MemorySearchResult,
	Project,
	ProjectStatus,
	SettingRecord,
	SkillImport,
	SkillScope,
	TaskCleanupSelection,
	TaskRun,
	TaskRunStatus,
	TaskStatus,
	WorkbenchSession,
	WorkbenchSkill,
	WorkbenchTask,
} from "./models.ts";
import type { ProjectDeletion, ProjectDeletionPreview } from "./project-deletion.ts";

export interface ActivityRepository {
	create(activity: ActivityRecord): Promise<ActivityRecord>;
	list(filter?: { projectId?: string; sessionId?: string; limit?: number }): Promise<ActivityRecord[]>;
}

export interface AgentProfileRepository {
	upsert(profile: AgentProfile, expectedVersion?: number): Promise<AgentProfile | undefined>;
	get(id: string): Promise<AgentProfile | undefined>;
	getBySlug(slug: string): Promise<AgentProfile | undefined>;
	list(filter?: { status?: AgentProfile["status"] }): Promise<AgentProfile[]>;
	getRevision(id: string, version: number): Promise<AgentProfileRevision | undefined>;
}

export interface SessionRepository {
	delete(id: string): Promise<void>;
	create(session: WorkbenchSession): Promise<WorkbenchSession>;
	get(id: string): Promise<WorkbenchSession | undefined>;
	getByRuntimeSession(runtime: string, runtimeSessionId: string): Promise<WorkbenchSession | undefined>;
	list(projectId?: string): Promise<WorkbenchSession[]>;
	update(session: WorkbenchSession): Promise<WorkbenchSession>;
	updateTitle(
		id: string,
		title: string,
		updatedAt: string,
		expectedTitle?: string,
	): Promise<WorkbenchSession | undefined>;
	updateRunStatus(id: string, status: WorkbenchSession["status"], activeAt: string): Promise<WorkbenchSession>;
	markRunningInterrupted(updatedAt: string): Promise<number>;
}

export interface AgentRunRepository {
	create(run: AgentRun): Promise<AgentRun>;
	get(id: string): Promise<AgentRun | undefined>;
	getRunningBySession(sessionId: string): Promise<AgentRun | undefined>;
	latestSettled(sessionId: string): Promise<AgentRun | undefined>;
	update(run: AgentRun): Promise<AgentRun>;
	markRunningInterrupted(settledAt: string): Promise<number>;
}

export interface ProjectRepository {
	previewDeletion(id: string): Promise<ProjectDeletionPreview>;
	inspectDeletion(id: string): Promise<ProjectDeletion>;
	beginDeletion(id: string, expectedFingerprint: string): Promise<ProjectDeletion>;
	pendingDeletions(): Promise<ProjectDeletion[]>;
	finishDeletion(id: string): Promise<void>;
	isDeleting(id: string): Promise<boolean>;
	create(project: Project): Promise<void>;
	get(id: string): Promise<Project | undefined>;
	getBySlug(slug: string): Promise<Project | undefined>;
	list(status?: ProjectStatus): Promise<Project[]>;
	setStatus(id: string, status: ProjectStatus, updatedAt: string, archivedAt?: string): Promise<Project>;
}

export interface TaskRepository {
	requestCleanup(selection: TaskCleanupSelection[], deleteHistory: boolean, requestedAt: string): Promise<void>;
	completeCleanup(id: string): Promise<void>;
	create(task: WorkbenchTask): Promise<WorkbenchTask>;
	get(id: string): Promise<WorkbenchTask | undefined>;
	list(filter: { projectId?: string; status?: TaskStatus }): Promise<WorkbenchTask[]>;
	update(task: WorkbenchTask, expectedVersion: number): Promise<WorkbenchTask | undefined>;
}

export interface TaskRunRepository {
	create(run: TaskRun): Promise<TaskRun>;
	get(id: string): Promise<TaskRun | undefined>;
	list(taskId?: string): Promise<TaskRun[]>;
	update(
		id: string,
		status: TaskRunStatus,
		input: { agentRunId?: string; finishedAt?: string; errorCode?: string; summary?: string },
	): Promise<TaskRun>;
	markRunningInterrupted(finishedAt: string): Promise<TaskRun[]>;
}

export interface MemoryRepository {
	listFiles(): Promise<MemoryFileRecord[]>;
	deleteFile(kind: MemoryKind, projectId: string | undefined, relativePath: string): Promise<void>;
	getCandidate(id: string): Promise<MemoryCandidate | undefined>;
	getCandidateByIdempotencyKey(key: string): Promise<MemoryCandidate | undefined>;
	listCandidates(status?: MemoryCandidateStatus): Promise<MemoryCandidate[]>;
	createCandidate(candidate: MemoryCandidate): Promise<MemoryCandidate>;
	updateCandidate(candidate: MemoryCandidate): Promise<MemoryCandidate>;
	replaceFileIndex(file: MemoryFileRecord, entries: MemoryIndexEntry[]): Promise<void>;
	completeCandidate(candidate: MemoryCandidate, file: MemoryFileRecord, entries: MemoryIndexEntry[]): Promise<void>;
	search(
		query: string,
		scope: { projectId?: string; kinds: MemoryKind[]; limit: number },
	): Promise<MemorySearchResult[]>;
}

export interface ArtifactRepository {
	getByIdempotencyKey(key: string): Promise<Artifact | undefined>;
	create(artifact: Artifact): Promise<Artifact>;
	list(projectId?: string): Promise<Artifact[]>;
}

export interface SettingsRepository {
	get(key: string): Promise<SettingRecord | undefined>;
	set(record: SettingRecord, expectedVersion?: number): Promise<SettingRecord | undefined>;
	list(): Promise<SettingRecord[]>;
}

export interface SkillRepository {
	upsert(skill: WorkbenchSkill): Promise<WorkbenchSkill>;
	get(id: string): Promise<WorkbenchSkill | undefined>;
	list(filter?: { scope?: SkillScope; projectId?: string }): Promise<WorkbenchSkill[]>;
	setEnabled(id: string, enabled: boolean, updatedAt: string): Promise<WorkbenchSkill | undefined>;
}

export interface McpConnectionRepository {
	create(connection: McpConnection): Promise<McpConnection>;
	get(id: string): Promise<McpConnection | undefined>;
	list(): Promise<McpConnection[]>;
	update(connection: McpConnection, expectedVersion: number): Promise<McpConnection | undefined>;
	replaceTools(connectionId: string, tools: McpToolRecord[]): Promise<void>;
	listTools(connectionId: string): Promise<McpToolRecord[]>;
}

export interface SkillImportRepository {
	commit(value: SkillImport, skills: WorkbenchSkill[]): Promise<SkillImport>;
	create(value: SkillImport): Promise<SkillImport>;
	get(id: string): Promise<SkillImport | undefined>;
	update(value: SkillImport): Promise<SkillImport>;
	list(status?: SkillImport["status"]): Promise<SkillImport[]>;
}

export interface AssistantDraftRepository {
	create(value: AssistantDraft): Promise<AssistantDraft>;
	get(id: string): Promise<AssistantDraft | undefined>;
	update(value: AssistantDraft, expectedVersion: number): Promise<AssistantDraft | undefined>;
	list(status?: AssistantDraftStatus): Promise<AssistantDraft[]>;
}

export interface ApprovalRepository {
	create(approval: Approval): Promise<Approval>;
	get(id: string): Promise<Approval | undefined>;
	listPending(): Promise<Approval[]>;
	resolve(id: string, from: ApprovalStatus, to: ApprovalStatus, resolvedAt: string): Promise<Approval | undefined>;
	expirePending(resolvedAt: string): Promise<Approval[]>;
}
