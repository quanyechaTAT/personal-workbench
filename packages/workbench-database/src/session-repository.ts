import type { SessionRepository, WorkbenchSession } from "@earendil-works/workbench-core";
import type { WorkbenchDatabase } from "./database.ts";

interface SessionRow {
	thinking_level: WorkbenchSession["thinkingLevel"] | null;
	archived_at: string | null;
	deletion_requested_at: string | null;
	id: string;
	runtime: string;
	runtime_session_id: string;
	runtime_ref: string;
	project_id: string | null;
	agent_profile_id: string;
	title: string;
	kind: WorkbenchSession["kind"];
	status: WorkbenchSession["status"];
	cwd: string;
	model_json: string | null;
	model_override_json: string | null;
	applied_profile_version: number | null;
	configuration_fingerprint: string | null;
	created_at: string;
	updated_at: string;
	last_active_at: string;
	closed_at: string | null;
	unavailable_reason: string | null;
}

function parseModel(json: string | null): WorkbenchSession["model"] {
	if (!json) return undefined;
	const value: unknown = JSON.parse(json);
	if (
		typeof value === "object" &&
		value !== null &&
		"provider" in value &&
		typeof value.provider === "string" &&
		"modelId" in value &&
		typeof value.modelId === "string"
	) {
		return { provider: value.provider, modelId: value.modelId };
	}
	return undefined;
}

function mapSession(row: SessionRow): WorkbenchSession {
	return {
		thinkingLevel: row.thinking_level ?? undefined,
		archivedAt: row.archived_at ?? undefined,
		deletionRequestedAt: row.deletion_requested_at ?? undefined,
		id: row.id,
		runtime: row.runtime,
		runtimeSessionId: row.runtime_session_id,
		runtimeRef: row.runtime_ref,
		projectId: row.project_id ?? undefined,
		agentProfileId: row.agent_profile_id,
		title: row.title,
		kind: row.kind,
		status: row.status,
		cwd: row.cwd,
		model: parseModel(row.model_json),
		modelOverride: parseModel(row.model_override_json),
		appliedProfileVersion: row.applied_profile_version ?? undefined,
		configurationFingerprint: row.configuration_fingerprint ?? undefined,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		lastActiveAt: row.last_active_at,
		closedAt: row.closed_at ?? undefined,
		unavailableReason: row.unavailable_reason ?? undefined,
	};
}

export class SqliteSessionRepository implements SessionRepository {
	private readonly database: WorkbenchDatabase;

	constructor(database: WorkbenchDatabase) {
		this.database = database;
	}

	async create(session: WorkbenchSession): Promise<WorkbenchSession> {
		this.database
			.prepare(
				`INSERT INTO sessions(
          id, runtime, runtime_session_id, runtime_ref, project_id, agent_profile_id, title, kind, status,
          cwd, model_json, applied_profile_version, configuration_fingerprint,
          created_at, updated_at, last_active_at, closed_at, unavailable_reason, model_override_json,
          archived_at, deletion_requested_at, thinking_level
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(...this.values(session));
		return session;
	}

	async get(id: string): Promise<WorkbenchSession | undefined> {
		const row = this.database.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRow | undefined;
		return row ? mapSession(row) : undefined;
	}

	async getByRuntimeSession(runtime: string, runtimeSessionId: string): Promise<WorkbenchSession | undefined> {
		const row = this.database
			.prepare("SELECT * FROM sessions WHERE runtime = ? AND runtime_session_id = ?")
			.get(runtime, runtimeSessionId) as SessionRow | undefined;
		return row ? mapSession(row) : undefined;
	}

	async list(projectId?: string): Promise<WorkbenchSession[]> {
		const rows = projectId
			? (this.database
					.prepare("SELECT * FROM sessions WHERE project_id = ? ORDER BY last_active_at DESC")
					.all(projectId) as unknown as SessionRow[])
			: (this.database
					.prepare("SELECT * FROM sessions ORDER BY last_active_at DESC")
					.all() as unknown as SessionRow[]);
		return rows.map(mapSession);
	}

	async update(session: WorkbenchSession): Promise<WorkbenchSession> {
		this.database
			.prepare(
				`UPDATE sessions SET
          runtime = ?, runtime_session_id = ?, runtime_ref = ?, project_id = ?, agent_profile_id = ?,
          title = ?, kind = ?, status = ?, cwd = ?, model_json = ?, applied_profile_version = ?,
          configuration_fingerprint = ?, created_at = ?, updated_at = ?,
          last_active_at = ?, closed_at = ?, unavailable_reason = ?, model_override_json = ?,
          archived_at = ?, deletion_requested_at = ?, thinking_level = ?
        WHERE id = ?`,
			)
			.run(...this.values(session).slice(1), session.id);
		return session;
	}

	async markRunningInterrupted(updatedAt: string): Promise<number> {
		const result = this.database
			.prepare("UPDATE sessions SET status = 'interrupted', updated_at = ? WHERE status = 'running'")
			.run(updatedAt);
		return Number(result.changes);
	}

	async updateTitle(
		id: string,
		title: string,
		updatedAt: string,
		expectedTitle?: string,
	): Promise<WorkbenchSession | undefined> {
		const row = this.database
			.prepare(
				`UPDATE sessions SET title = ?, updated_at = ?
			 WHERE id = ? AND deletion_requested_at IS NULL ${expectedTitle === undefined ? "" : "AND title = ?"}
			 RETURNING *`,
			)
			.get(title, updatedAt, id, ...(expectedTitle === undefined ? [] : [expectedTitle])) as SessionRow | undefined;
		return row ? mapSession(row) : undefined;
	}

	async updateRunStatus(id: string, status: WorkbenchSession["status"], activeAt: string): Promise<WorkbenchSession> {
		const row = this.database
			.prepare("UPDATE sessions SET status = ?, updated_at = ?, last_active_at = ? WHERE id = ? RETURNING *")
			.get(status, activeAt, activeAt, id) as SessionRow | undefined;
		if (!row) throw new Error(`Session not found: ${id}`);
		return mapSession(row);
	}

	async delete(id: string): Promise<void> {
		this.database.transaction(() => {
			this.database.prepare("UPDATE artifacts SET session_id = NULL WHERE session_id = ?").run(id);
			this.database
				.prepare("UPDATE task_runs SET session_id = NULL, agent_run_id = NULL WHERE session_id = ?")
				.run(id);
			this.database
				.prepare("UPDATE memory_candidates SET session_id = NULL, run_id = NULL WHERE session_id = ?")
				.run(id);
			this.database.prepare("UPDATE activity SET session_id = NULL, run_id = NULL WHERE session_id = ?").run(id);
			this.database.prepare("DELETE FROM approvals WHERE session_id = ?").run(id);
			this.database.prepare("DELETE FROM settings WHERE key = ?").run(`permissions.session.${id}`);
			this.database.prepare("DELETE FROM sessions WHERE id = ?").run(id);
		});
	}

	private values(session: WorkbenchSession): Array<string | number | null> {
		return [
			session.id,
			session.runtime,
			session.runtimeSessionId,
			session.runtimeRef,
			session.projectId ?? null,
			session.agentProfileId,
			session.title,
			session.kind,
			session.status,
			session.cwd,
			session.model ? JSON.stringify(session.model) : null,
			session.appliedProfileVersion ?? null,
			session.configurationFingerprint ?? null,
			session.createdAt,
			session.updatedAt,
			session.lastActiveAt,
			session.closedAt ?? null,
			session.unavailableReason ?? null,
			session.modelOverride ? JSON.stringify(session.modelOverride) : null,
			session.archivedAt ?? null,
			session.deletionRequestedAt ?? null,
			session.thinkingLevel ?? null,
		];
	}
}
