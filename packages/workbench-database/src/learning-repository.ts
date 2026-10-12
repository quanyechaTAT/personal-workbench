import type { LearningRepository, LearningSnapshot } from "@earendil-works/workbench-core";
import type {
	LearningCadence,
	LearningReview,
	LearningRunReference,
	LearningSkillState,
	LearningSkillUse,
} from "@earendil-works/workbench-core/contracts";
import type { WorkbenchDatabase } from "./database.ts";

interface ReviewRow {
	data_json: string;
}
export class SqliteLearningRepository implements LearningRepository {
	private readonly database: WorkbenchDatabase;
	constructor(database: WorkbenchDatabase) {
		this.database = database;
	}
	async create(review: LearningReview): Promise<LearningReview> {
		this.database
			.prepare(
				"INSERT INTO project_learning_reviews(id, project_id, source_key, status, version, data_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
			)
			.run(
				review.id,
				review.projectId,
				review.sourceKey,
				review.status,
				review.version,
				JSON.stringify(review),
				review.createdAt,
				review.updatedAt,
			);
		return review;
	}
	async get(id: string): Promise<LearningReview | undefined> {
		const row = this.database.prepare("SELECT data_json FROM project_learning_reviews WHERE id = ?").get(id) as
			| ReviewRow
			| undefined;
		return row ? (JSON.parse(row.data_json) as LearningReview) : undefined;
	}
	async findSource(key: string): Promise<LearningReview | undefined> {
		const row = this.database
			.prepare("SELECT data_json FROM project_learning_reviews WHERE source_key = ?")
			.get(key) as ReviewRow | undefined;
		return row ? (JSON.parse(row.data_json) as LearningReview) : undefined;
	}
	async save(review: LearningReview, expectedVersion: number): Promise<LearningReview | undefined> {
		const result = this.database
			.prepare(
				"UPDATE project_learning_reviews SET status = ?, version = ?, data_json = ?, updated_at = ? WHERE id = ? AND version = ?",
			)
			.run(review.status, review.version, JSON.stringify(review), review.updatedAt, review.id, expectedVersion);
		return result.changes === 1 ? review : undefined;
	}
	async list(projectId?: string): Promise<LearningReview[]> {
		const rows = (projectId
			? this.database
					.prepare("SELECT data_json FROM project_learning_reviews WHERE project_id = ? ORDER BY created_at DESC")
					.all(projectId)
			: this.database
					.prepare("SELECT data_json FROM project_learning_reviews ORDER BY created_at DESC")
					.all()) as unknown as ReviewRow[];
		return rows.map((row) => JSON.parse(row.data_json) as LearningReview);
	}
	async page(
		projectId: string,
		offset: number,
		limit: number,
		pendingOnly = false,
	): Promise<{ reviews: LearningReview[]; total: number }> {
		const filter = pendingOnly
			? " AND (EXISTS (SELECT 1 FROM json_each(data_json, '$.changes') WHERE json_extract(value, '$.status') IN ('pending','conflicted')) OR json_array_length(data_json, '$.diagnostics') > 0)"
			: "";
		const rows = this.database
			.prepare(
				`SELECT data_json FROM project_learning_reviews WHERE project_id = ?${filter} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
			)
			.all(projectId, limit, offset) as unknown as ReviewRow[];
		const count = this.database
			.prepare(`SELECT COUNT(*) AS total FROM project_learning_reviews WHERE project_id = ?${filter}`)
			.get(projectId) as { total: number };
		return { reviews: rows.map((row) => JSON.parse(row.data_json) as LearningReview), total: count.total };
	}
	async saveSkillState(state: LearningSkillState): Promise<void> {
		this.database
			.prepare(
				"INSERT INTO learning_skill_state(skill_id, project_id, data_json) VALUES (?, ?, ?) ON CONFLICT(skill_id) DO UPDATE SET data_json = excluded.data_json",
			)
			.run(state.skillId, state.projectId, JSON.stringify(state));
	}
	async skillStates(projectId?: string): Promise<LearningSkillState[]> {
		const rows = (projectId
			? this.database.prepare("SELECT data_json FROM learning_skill_state WHERE project_id = ?").all(projectId)
			: this.database.prepare("SELECT data_json FROM learning_skill_state").all()) as unknown as ReviewRow[];
		return rows.map((row) => JSON.parse(row.data_json) as LearningSkillState);
	}
	async saveSkillUse(use: LearningSkillUse): Promise<void> {
		this.database
			.prepare(
				"INSERT INTO learning_skill_uses(run_id, skill_id, content_hash, project_id, loaded_at, data_json) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(run_id, skill_id, content_hash) DO UPDATE SET data_json = excluded.data_json",
			)
			.run(use.runId, use.skillId, use.contentHash, use.projectId, use.loadedAt, JSON.stringify(use));
	}
	async skillUses(projectId: string, runId?: string): Promise<LearningSkillUse[]> {
		const rows = (runId
			? this.database
					.prepare(
						"SELECT data_json FROM learning_skill_uses WHERE project_id = ? AND run_id = ? ORDER BY loaded_at DESC",
					)
					.all(projectId, runId)
			: this.database
					.prepare(
						"SELECT data_json FROM learning_skill_uses WHERE project_id = ? ORDER BY loaded_at DESC LIMIT 500",
					)
					.all(projectId)) as unknown as ReviewRow[];
		return rows.map((row) => JSON.parse(row.data_json) as LearningSkillUse);
	}
	async saveSnapshot(snapshot: LearningSnapshot): Promise<void> {
		this.database
			.prepare(
				"INSERT OR IGNORE INTO learning_snapshots(source_key, project_id, created_at, data_json) VALUES (?, ?, ?, ?)",
			)
			.run(snapshot.sourceKey, snapshot.projectId, snapshot.createdAt, JSON.stringify(snapshot));
	}
	async getSnapshot(sourceKey: string): Promise<LearningSnapshot | undefined> {
		const row = this.database
			.prepare("SELECT data_json FROM learning_snapshots WHERE source_key = ?")
			.get(sourceKey) as ReviewRow | undefined;
		return row ? (JSON.parse(row.data_json) as LearningSnapshot) : undefined;
	}
	async advanceCadence(
		sessionId: string,
		projectId: string,
		run: LearningRunReference,
		iterations: number,
	): Promise<LearningCadence | undefined> {
		return this.database.transaction(() => {
			const inserted = this.database
				.prepare("INSERT OR IGNORE INTO learning_counted_runs(run_id, session_id) VALUES (?, ?)")
				.run(run.id, sessionId);
			if (!inserted.changes) return undefined;
			const row = this.database
				.prepare("SELECT data_json FROM learning_cadence WHERE session_id = ?")
				.get(sessionId) as ReviewRow | undefined;
			const state: LearningCadence = row
				? (JSON.parse(row.data_json) as LearningCadence)
				: { sessionId, projectId, turns: 0, iterations: 0, runs: [], updatedAt: run.settledAt };
			state.turns++;
			state.iterations += iterations;
			state.runs = [...state.runs, run].slice(-64);
			state.updatedAt = run.settledAt;
			this.database
				.prepare(
					"INSERT INTO learning_cadence(session_id, project_id, data_json) VALUES (?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET data_json = excluded.data_json",
				)
				.run(sessionId, projectId, JSON.stringify(state));
			return state;
		});
	}
	async cadences(projectId: string): Promise<LearningCadence[]> {
		const rows = this.database
			.prepare("SELECT data_json FROM learning_cadence WHERE project_id = ?")
			.all(projectId) as unknown as ReviewRow[];
		return rows.map((row) => JSON.parse(row.data_json) as LearningCadence);
	}
	async consumeCadence(sessionId: string, runIds: string[]): Promise<void> {
		this.database.transaction(() => {
			const row = this.database
				.prepare("SELECT data_json FROM learning_cadence WHERE session_id = ?")
				.get(sessionId) as ReviewRow | undefined;
			if (!row) return;
			const state = JSON.parse(row.data_json) as LearningCadence;
			state.runs = state.runs.filter((run) => !runIds.includes(run.id));
			// Older references may have fallen outside the bounded window. They must not
			// leave phantom counters after that window is consumed; preserve only newer arrivals.
			state.turns = state.runs.length;
			state.iterations = state.runs.reduce((total, run) => total + run.iterations, 0);
			this.database
				.prepare("UPDATE learning_cadence SET data_json = ? WHERE session_id = ?")
				.run(JSON.stringify(state), sessionId);
		});
	}
	async clearLegacyHistory(): Promise<boolean> {
		return this.database.transaction(() => {
			if (!this.database.prepare("SELECT 1 FROM settings WHERE key = 'learning.historyResetPending'").get())
				return false;
			this.database.exec(`
				DELETE FROM project_learning_reviews;
				DELETE FROM learning_snapshots;
				DELETE FROM learning_cadence;
				UPDATE learning_skill_state SET data_json = json_remove(data_json, '$.reviewId', '$.changeId');
				DELETE FROM activity WHERE type LIKE 'learning.%';
				DELETE FROM settings WHERE key = 'learning.historyResetPending';
			`);
			// Keep counted-run IDs: duplicate settled events must not replay old learning.
			return true;
		});
	}
}
