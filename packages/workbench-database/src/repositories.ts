import type {
	ActivityRepository,
	AgentProfileRepository,
	AgentRunRepository,
	ApprovalRepository,
	ArtifactRepository,
	AssistantDraftRepository,
	KnowledgeRepository,
	LearningRepository,
	McpConnectionRepository,
	MemoryRepository,
	MemoryStateRepository,
	ProjectRepository,
	SemanticRepository,
	SessionRepository,
	SettingsRepository,
	SkillImportRepository,
	SkillRepository,
	TaskRepository,
	TaskRunRepository,
} from "@earendil-works/workbench-core";
import { SqliteActivityRepository } from "./activity-repository.ts";
import { SqliteAgentRunRepository } from "./agent-run-repository.ts";
import { SqliteApprovalRepository } from "./approval-repository.ts";
import { SqliteArtifactRepository } from "./artifact-repository.ts";
import { SqliteAssistantDraftRepository } from "./assistant-draft-repository.ts";
import type { WorkbenchDatabase } from "./database.ts";
import { SqliteKnowledgeRepository } from "./knowledge-repository.ts";
import { SqliteLearningRepository } from "./learning-repository.ts";
import { SqliteMcpConnectionRepository } from "./mcp-connection-repository.ts";
import { SqliteMemoryRepository } from "./memory-repository.ts";
import { SqliteMemoryStateRepository } from "./memory-state-repository.ts";
import { SqliteAgentProfileRepository } from "./profile-repository.ts";
import { SqliteProjectRepository } from "./project-repository.ts";
import { SqliteSemanticRepository } from "./semantic-repository.ts";
import { SqliteSessionRepository } from "./session-repository.ts";
import { SqliteSettingsRepository } from "./settings-repository.ts";
import { SqliteSkillImportRepository } from "./skill-import-repository.ts";
import { SqliteSkillRepository } from "./skill-repository.ts";
import { SqliteTaskRepository } from "./task-repository.ts";
import { SqliteTaskRunRepository } from "./task-run-repository.ts";

export interface WorkbenchRepositories {
	activity: ActivityRepository;
	profiles: AgentProfileRepository;
	sessions: SessionRepository;
	agentRuns: AgentRunRepository;
	projects: ProjectRepository;
	tasks: TaskRepository;
	taskRuns: TaskRunRepository;
	memory: MemoryRepository;
	memoryState: MemoryStateRepository;
	semantic: SemanticRepository;
	knowledge: KnowledgeRepository;
	learning: LearningRepository;
	artifacts: ArtifactRepository;
	settings: SettingsRepository;
	skills: SkillRepository;
	approvals: ApprovalRepository;
	mcpConnections: McpConnectionRepository;
	skillImports: SkillImportRepository;
	assistantDrafts: AssistantDraftRepository;
}

export function createWorkbenchRepositories(database: WorkbenchDatabase): WorkbenchRepositories {
	return {
		activity: new SqliteActivityRepository(database),
		profiles: new SqliteAgentProfileRepository(database),
		sessions: new SqliteSessionRepository(database),
		agentRuns: new SqliteAgentRunRepository(database),
		projects: new SqliteProjectRepository(database),
		tasks: new SqliteTaskRepository(database),
		taskRuns: new SqliteTaskRunRepository(database),
		memory: new SqliteMemoryRepository(database),
		memoryState: new SqliteMemoryStateRepository(database),
		semantic: new SqliteSemanticRepository(database),
		knowledge: new SqliteKnowledgeRepository(database),
		learning: new SqliteLearningRepository(database),
		artifacts: new SqliteArtifactRepository(database),
		settings: new SqliteSettingsRepository(database),
		skills: new SqliteSkillRepository(database),
		approvals: new SqliteApprovalRepository(database),
		mcpConnections: new SqliteMcpConnectionRepository(database),
		skillImports: new SqliteSkillImportRepository(database),
		assistantDrafts: new SqliteAssistantDraftRepository(database),
	};
}
