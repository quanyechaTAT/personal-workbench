import { createHash } from "node:crypto";
import {
	type Project,
	type ProjectDeletion,
	type ProjectDeletionPreview,
	type ProjectRepository,
	WorkbenchError,
} from "@earendil-works/workbench-core";
import type { WorkbenchDatabase } from "./database.ts";

interface ProjectRow {
	id: string;
	slug: string;
	name: string;
	description: string;
	status: Project["status"];
	workspace_path: string;
	source_path: string | null;
	default_profile_id: string | null;
	project_file_path: string;
	memory_file_path: string;
	created_at: string;
	updated_at: string;
	archived_at: string | null;
}

function mapProject(row: ProjectRow): Project {
	return {
		id: row.id,
		slug: row.slug,
		name: row.name,
		description: row.description,
		status: row.status,
		workspacePath: row.workspace_path,
		sourcePath: row.source_path ?? undefined,
		defaultProfileId: row.default_profile_id ?? undefined,
		projectFilePath: row.project_file_path,
		memoryFilePath: row.memory_file_path,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		archivedAt: row.archived_at ?? undefined,
	};
}

export class SqliteProjectRepository implements ProjectRepository {
	private readonly database: WorkbenchDatabase;

	constructor(database: WorkbenchDatabase) {
		this.database = database;
	}

	async create(project: Project): Promise<void> {
		this.database
			.prepare(
				`INSERT INTO projects(
          id, slug, name, description, status, workspace_path, project_file_path, memory_file_path,
          created_at, updated_at, archived_at, source_path, default_profile_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				project.id,
				project.slug,
				project.name,
				project.description,
				project.status,
				project.workspacePath,
				project.projectFilePath,
				project.memoryFilePath,
				project.createdAt,
				project.updatedAt,
				project.archivedAt ?? null,
				project.sourcePath ?? null,
				project.defaultProfileId ?? null,
			);
	}

	async get(id: string): Promise<Project | undefined> {
		const row = this.database.prepare("SELECT * FROM projects WHERE id = ?").get(id) as ProjectRow | undefined;
		return row ? mapProject(row) : undefined;
	}

	async getBySlug(slug: string): Promise<Project | undefined> {
		const row = this.database.prepare("SELECT * FROM projects WHERE slug = ?").get(slug) as ProjectRow | undefined;
		return row ? mapProject(row) : undefined;
	}

	async list(status?: Project["status"]): Promise<Project[]> {
		const rows = status
			? (this.database
					.prepare("SELECT * FROM projects WHERE status = ? ORDER BY updated_at DESC")
					.all(status) as unknown as ProjectRow[])
			: (this.database.prepare("SELECT * FROM projects ORDER BY updated_at DESC").all() as unknown as ProjectRow[]);
		return rows.map(mapProject);
	}

	async setStatus(id: string, status: Project["status"], updatedAt: string, archivedAt?: string): Promise<Project> {
		const result = this.database
			.prepare("UPDATE projects SET status = ?, updated_at = ?, archived_at = ? WHERE id = ?")
			.run(status, updatedAt, archivedAt ?? null, id);
		if (result.changes !== 1) throw new WorkbenchError("not_found", `Project not found: ${id}`);
		return (await this.get(id))!;
	}

	async isDeleting(id: string): Promise<boolean> {
		return Boolean(this.database.prepare("SELECT 1 FROM project_deletions WHERE project_id=?").get(id));
	}
	async pendingDeletions(): Promise<ProjectDeletion[]> {
		return this.database
			.prepare("SELECT data_json FROM project_deletions ORDER BY requested_at")
			.all()
			.map((row) => JSON.parse(String(row.data_json)) as ProjectDeletion);
	}
	async previewDeletion(id: string): Promise<ProjectDeletionPreview> {
		const intent = await this.inspectDeletion(id);
		return intent.preview;
	}
	async inspectDeletion(id: string): Promise<ProjectDeletion> {
		const pending = (await this.pendingDeletions()).find((intent) => intent.project.id === id);
		return pending ? { ...pending, preview: { ...pending.preview, pending: true } } : this.deletionScope(id);
	}
	async beginDeletion(id: string, expectedFingerprint: string): Promise<ProjectDeletion> {
		return this.database.transaction(() => {
			const row = this.database.prepare("SELECT data_json FROM project_deletions WHERE project_id=?").get(id);
			const intent = row ? (JSON.parse(String(row.data_json)) as ProjectDeletion) : this.deletionScope(id);
			if (intent.preview.fingerprint !== expectedFingerprint)
				throw new WorkbenchError("conflict", "项目数据已变化，请刷新删除预览后再确认");
			if (!row)
				this.database
					.prepare("INSERT INTO project_deletions VALUES(?,?,?)")
					.run(id, JSON.stringify(intent), new Date().toISOString());
			return intent;
		});
	}
	private deletionScope(id: string): ProjectDeletion {
		const row = this.database.prepare("SELECT * FROM projects WHERE id=?").get(id) as ProjectRow | undefined;
		if (!row) throw new WorkbenchError("not_found", "项目不存在");
		const project = mapProject(row);
		const ids = (table: string, where = "project_id=?") =>
			this.database
				.prepare(`SELECT id FROM ${table} WHERE ${where} ORDER BY id`)
				.all(id)
				.map((value) => String(value.id));
		const sessions = this.database
			.prepare("SELECT id,runtime_session_id FROM sessions WHERE project_id=? ORDER BY id")
			.all(id)
			.map((value) => ({ id: String(value.id), runtimeSessionId: String(value.runtime_session_id) }));
		const taskIds = ids("tasks"),
			skillIds = ids("skills"),
			artifactIds = ids("artifacts");
		const runIds = ids("agent_runs", "session_id IN (SELECT id FROM sessions WHERE project_id=?)");
		const taskRunIds = ids("task_runs", "task_id IN (SELECT id FROM tasks WHERE project_id=?)");
		const reviewIds = ids("project_learning_reviews"),
			episodeIds = ids("episodic_memories");
		const documentIds = ids("knowledge_documents"),
			importIds = ids("skill_imports");
		const semanticIds = this.database
			.prepare(
				"SELECT id FROM semantic_memories WHERE project_id=? UNION SELECT id FROM semantic_versions WHERE json_extract(data_json,'$.projectId')=? ORDER BY id",
			)
			.all(id, id)
			.map((value) => String(value.id));
		const memoryPaths = [
			...new Set([
				...this.database
					.prepare(
						"SELECT relative_path FROM memory_files WHERE project_id=? UNION SELECT json_extract(data_json,'$.relativePath') AS relative_path FROM memory_write_intents WHERE json_extract(data_json,'$.projectId')=?",
					)
					.all(id, id)
					.map((value) => String(value.relative_path)),
				...["AGENTS.md", "MEMORY.md", "PROJECT.md"].map((name) => `projects/${project.slug}/${name}`),
			]),
		].sort();
		const scope = {
			project,
			sessions,
			taskIds,
			runIds,
			reviewIds,
			semanticIds,
			memoryPaths,
			importIds,
			resourceIds: [
				id,
				...sessions.map((session) => session.id),
				...taskIds,
				...runIds,
				...taskRunIds,
				...artifactIds,
				...skillIds,
				...ids("memory_candidates"),
				...reviewIds,
				...semanticIds,
				...episodeIds,
				...documentIds,
				...importIds,
			],
		};
		const fingerprint = createHash("sha256").update(JSON.stringify(scope)).digest("hex");
		return {
			...scope,
			preview: {
				projectId: id,
				name: project.name,
				workspacePath: project.workspacePath,
				sourcePath: project.sourcePath,
				fingerprint,
				pending: false,
				counts: {
					sessions: sessions.length,
					tasks: taskIds.length,
					artifacts: artifactIds.length,
					skills: skillIds.length,
					facts: semanticIds.length,
					episodes: episodeIds.length,
					documents: documentIds.length,
					reviews: reviewIds.length,
				},
			},
		};
	}
	async finishDeletion(id: string): Promise<void> {
		const intent = (await this.pendingDeletions()).find((value) => value.project.id === id);
		if (!intent) throw new WorkbenchError("conflict", "项目删除意图缺失");
		this.database.transaction(() => {
			// Virtual indexes have no FK cascade. Remove rows before their source chunks disappear.
			for (const row of this.database
				.prepare("SELECT rowid,dimension FROM knowledge_chunks WHERE project_id=? AND dimension>0")
				.all(id)) {
				const dimension = Number(row.dimension);
				if (!Number.isInteger(dimension) || dimension < 1 || dimension > 8192)
					throw new WorkbenchError("storage_failure", "知识向量维度无效");
				this.database
					.prepare(`DELETE FROM knowledge_vec_${dimension} WHERE chunk_id=?`)
					.run(BigInt(String(row.rowid)));
			}
			this.database.prepare("DELETE FROM knowledge_keywords WHERE project_id=?").run(id);
			for (const semanticId of intent.semanticIds)
				this.database.prepare("DELETE FROM semantic_versions WHERE id=?").run(semanticId);
			this.database.prepare("DELETE FROM semantic_memories WHERE project_id=?").run(id);
			this.database
				.prepare("DELETE FROM memory_write_intents WHERE json_extract(data_json,'$.projectId')=?")
				.run(id);
			for (const table of [
				"episodic_memories",
				"working_checkpoints",
				"memory_candidates",
				"memory_files",
				"skill_imports",
				"skills",
				"artifacts",
				"activity",
			])
				this.database.prepare(`DELETE FROM ${table} WHERE project_id=?`).run(id);
			for (const session of intent.sessions) {
				this.database.prepare("DELETE FROM approvals WHERE session_id=?").run(session.id);
				this.database.prepare("DELETE FROM settings WHERE key=?").run(`permissions.session.${session.id}`);
			}
			for (const prefix of ["learning.project.", "learning.schedule."])
				this.database.prepare("DELETE FROM settings WHERE key=?").run(`${prefix}${id}`);
			for (const resourceId of intent.resourceIds)
				this.database.prepare("DELETE FROM idempotency_records WHERE resource_id=?").run(resourceId);
			// Shared sessions/profiles and tasks in other projects remain usable.
			this.database
				.prepare(
					"UPDATE tasks SET parent_id=NULL WHERE parent_id IN(SELECT id FROM tasks WHERE project_id=?) AND (project_id IS NULL OR project_id!=?)",
				)
				.run(id, id);
			this.database
				.prepare(
					"UPDATE artifacts SET task_run_id=NULL WHERE task_run_id IN(SELECT id FROM task_runs WHERE task_id IN(SELECT id FROM tasks WHERE project_id=?))",
				)
				.run(id);
			this.database
				.prepare(
					"UPDATE agent_runs SET task_run_id=NULL WHERE task_run_id IN(SELECT id FROM task_runs WHERE task_id IN(SELECT id FROM tasks WHERE project_id=?))",
				)
				.run(id);
			this.database.prepare("DELETE FROM tasks WHERE project_id=?").run(id);
			this.database.prepare("DELETE FROM projects WHERE id=?").run(id);
		});
	}
}
