import type { SQLInputValue } from "node:sqlite";
import type {
	ContextAssemblyResult,
	EpisodeQuery,
	EpisodicMemory,
	MemoryStateRepository,
	WorkingCheckpoint,
} from "@earendil-works/workbench-core";
import { WorkbenchError } from "@earendil-works/workbench-core";
import type { WorkbenchDatabase } from "./database.ts";
import { knowledgeTerms } from "./knowledge-repository.ts";

interface JsonRow {
	data_json: string;
}

function episodeScope(query: EpisodeQuery): { clauses: string[]; parameters: SQLInputValue[] } {
	const clauses = [query.projectId ? "project_id = ?" : "project_id IS NULL"];
	const parameters: SQLInputValue[] = query.projectId ? [query.projectId] : [];
	for (const [column, value] of [
		["session_id", query.sessionId],
		["task_id", query.taskId],
	] as const) {
		if (value) {
			clauses.push(`${column} = ?`);
			parameters.push(value);
		}
	}
	if (query.from) {
		clauses.push("occurred_at >= ?");
		parameters.push(query.from);
	}
	if (query.until) {
		clauses.push("occurred_at <= ?");
		parameters.push(query.until);
	}
	clauses.push("(json_extract(data_json, '$.expiresAt') IS NULL OR json_extract(data_json, '$.expiresAt') > ?)");
	parameters.push(new Date().toISOString());
	return { clauses, parameters };
}

export class SqliteMemoryStateRepository implements MemoryStateRepository {
	private readonly database: WorkbenchDatabase;
	constructor(database: WorkbenchDatabase) {
		this.database = database;
	}
	async getCheckpoint(sessionId: string): Promise<WorkingCheckpoint | undefined> {
		const row = this.database
			.prepare("SELECT data_json FROM working_checkpoints WHERE session_id = ?")
			.get(sessionId) as JsonRow | undefined;
		return row ? (JSON.parse(row.data_json) as WorkingCheckpoint) : undefined;
	}
	async saveCheckpoint(value: WorkingCheckpoint, expectedVersion: number): Promise<WorkingCheckpoint | undefined> {
		if (value.version !== expectedVersion + 1) throw new Error("Checkpoint version must increase by one");
		const values = [
			value.projectId ?? null,
			value.runId ?? null,
			value.version,
			value.status,
			value.expiresAt,
			value.updatedAt,
			JSON.stringify(value),
			value.sessionId,
		];
		const result =
			expectedVersion === 0
				? this.database
						.prepare(
							"INSERT OR IGNORE INTO working_checkpoints(project_id, run_id, version, status, expires_at, updated_at, data_json, session_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
						)
						.run(...values)
				: this.database
						.prepare(
							"UPDATE working_checkpoints SET project_id = ?, run_id = ?, version = ?, status = ?, expires_at = ?, updated_at = ?, data_json = ? WHERE session_id = ? AND version = ?",
						)
						.run(...values, expectedVersion);
		return result.changes === 1 ? value : undefined;
	}
	async interruptRunning(at: string): Promise<number> {
		this.database
			.prepare(
				"UPDATE working_checkpoints SET version=version+1, updated_at=?, data_json=json_set(data_json,'$.review.status','interrupted','$.review.error','后台整理被重启中断，可在下一运行重试','$.version',version+1,'$.updatedAt',?) WHERE json_extract(data_json,'$.review.status') IN ('queued','running')",
			)
			.run(at, at);
		return Number(
			this.database
				.prepare(
					"UPDATE working_checkpoints SET status = 'interrupted', version = version + 1, updated_at = ?, data_json = json_set(data_json, '$.status', 'interrupted', '$.version', version + 1, '$.updatedAt', ?) WHERE status = 'running'",
				)
				.run(at, at).changes,
		);
	}
	async cleanupExpired(at: string): Promise<number> {
		return Number(
			this.database.prepare("DELETE FROM working_checkpoints WHERE expires_at <= ? AND status <> 'running'").run(at)
				.changes,
		);
	}
	async interruptedCheckpoints(): Promise<WorkingCheckpoint[]> {
		const rows = this.database
			.prepare("SELECT data_json FROM working_checkpoints WHERE status='interrupted'")
			.all() as unknown as JsonRow[];
		return rows.map((row) => JSON.parse(row.data_json) as WorkingCheckpoint);
	}
	async getEpisode(id: string): Promise<EpisodicMemory | undefined> {
		const row = this.database.prepare("SELECT data_json FROM episodic_memories WHERE id = ?").get(id) as
			| JsonRow
			| undefined;
		return row ? (JSON.parse(row.data_json) as EpisodicMemory) : undefined;
	}
	async getRunEpisode(runId: string): Promise<EpisodicMemory | undefined> {
		const row = this.database.prepare("SELECT data_json FROM episodic_memories WHERE run_id = ?").get(runId) as
			| JsonRow
			| undefined;
		return row ? (JSON.parse(row.data_json) as EpisodicMemory) : undefined;
	}
	async saveEpisode(value: EpisodicMemory): Promise<EpisodicMemory> {
		this.database
			.prepare(
				"INSERT INTO episodic_memories(id, project_id, session_id, run_id, task_id, occurred_at, outcome, search_text, data_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(run_id) DO NOTHING",
			)
			.run(
				value.id,
				value.projectId ?? null,
				value.sessionId,
				value.runId,
				value.taskId ?? null,
				value.occurredAt,
				value.outcome,
				`${value.summary}\n${value.result}\n${value.actions.map((a) => a.result).join("\n")}`,
				JSON.stringify(value),
			);
		return (await this.getRunEpisode(value.runId))!;
	}
	async queryEpisodes(query: EpisodeQuery): Promise<EpisodicMemory[]> {
		const { clauses, parameters } = episodeScope(query);
		const terms = query.query ? knowledgeTerms(query.query).slice(0, 24) : [];
		if (terms.length) {
			clauses.push(`(${terms.map(() => "search_text LIKE ? ESCAPE '\\'").join(" OR ")})`);
			parameters.push(...terms.map((t) => `%${t.replace(/[\\%_]/g, "\\$&")}%`));
		}
		const rows = this.database
			.prepare(
				`SELECT data_json FROM episodic_memories WHERE ${clauses.join(" AND ")} ORDER BY ${terms.length ? `${terms.map(() => "(search_text LIKE ? ESCAPE '\\')").join(" + ")} DESC, ` : ""}occurred_at DESC LIMIT ?`,
			)
			.all(
				...parameters,
				...terms.map((t) => `%${t.replace(/[\\%_]/g, "\\$&")}%`),
				Math.min(10000, Math.max(1, query.limit ?? 20)),
			) as unknown as JsonRow[];
		return rows.map((row) => JSON.parse(row.data_json) as EpisodicMemory);
	}
	async hasEpisodeVectors(query: EpisodeQuery): Promise<boolean> {
		const { clauses, parameters } = episodeScope(query);
		return Boolean(
			this.database
				.prepare(
					`SELECT 1 FROM episodic_memories WHERE ${clauses.join(" AND ")} AND id IN (SELECT id FROM episodic_vectors) LIMIT 1`,
				)
				.get(...parameters),
		);
	}
	async saveEpisodeVector(id: string, version: number, space: string, vector: number[]): Promise<void> {
		if (!vector.length || vector.length > 8192 || !vector.every(Number.isFinite))
			throw new WorkbenchError("invalid_input", "经历向量无效");
		this.database
			.prepare(
				"INSERT INTO episodic_vectors SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM episodic_memories WHERE id=? AND json_extract(data_json,'$.version')=?) ON CONFLICT(id) DO UPDATE SET version=excluded.version, space_id=excluded.space_id, dimension=excluded.dimension, embedding=excluded.embedding",
			)
			.run(id, version, space, vector.length, new Uint8Array(new Float32Array(vector).buffer), id, version);
	}
	async searchEpisodeVectors(query: EpisodeQuery, space: string, vector: number[]): Promise<EpisodicMemory[]> {
		const { clauses, parameters } = episodeScope(query);
		const scoped = `WITH scoped AS MATERIALIZED (SELECT * FROM episodic_memories WHERE ${clauses.join(" AND ")})`;
		if (
			this.database
				.prepare(
					`${scoped} SELECT 1 FROM scoped m JOIN episodic_vectors v ON m.id=v.id AND json_extract(m.data_json,'$.version')=v.version WHERE v.space_id=? AND v.dimension<>? LIMIT 1`,
				)
				.get(...parameters, space, vector.length)
		)
			throw new WorkbenchError("conflict", "经历向量维度已改变，请重建索引");
		const rows = this.database
			.prepare(
				`${scoped} SELECT m.data_json FROM scoped m JOIN episodic_vectors v ON m.id=v.id AND json_extract(m.data_json,'$.version')=v.version WHERE v.space_id=? AND v.dimension=? AND vec_distance_cosine(v.embedding,?) < 1 ORDER BY vec_distance_cosine(v.embedding,?), m.occurred_at DESC LIMIT ?`,
			)
			.all(
				...parameters,
				space,
				vector.length,
				new Uint8Array(new Float32Array(vector).buffer),
				new Uint8Array(new Float32Array(vector).buffer),
				Math.min(100, query.limit ?? 20),
			) as unknown as JsonRow[];
		return rows.map((row) => JSON.parse(row.data_json) as EpisodicMemory);
	}
	async updateEpisode(value: EpisodicMemory, expectedVersion: number): Promise<boolean> {
		if (value.version !== expectedVersion + 1) throw new Error("Episode version must increase by one");
		return (
			this.database
				.prepare("UPDATE episodic_memories SET data_json=? WHERE id=? AND json_extract(data_json,'$.version')=?")
				.run(JSON.stringify(value), value.id, expectedVersion).changes === 1
		);
	}
	async deleteEpisode(id: string): Promise<boolean> {
		const episode = await this.getEpisode(id);
		if (episode && (episode.semanticIds.length || episode.skillIds.length)) return false;
		return this.database.prepare("DELETE FROM episodic_memories WHERE id = ?").run(id).changes === 1;
	}
	async saveContext(value: ContextAssemblyResult): Promise<void> {
		this.database
			.prepare(
				"INSERT INTO memory_contexts(session_id, run_id, request, data_json) VALUES (?, ?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET run_id = excluded.run_id, request = excluded.request, data_json = excluded.data_json",
			)
			.run(value.sessionId, value.runId, value.request, JSON.stringify(value));
	}
	async getContext(sessionId: string): Promise<ContextAssemblyResult | undefined> {
		const row = this.database.prepare("SELECT data_json FROM memory_contexts WHERE session_id = ?").get(sessionId) as
			| JsonRow
			| undefined;
		return row ? (JSON.parse(row.data_json) as ContextAssemblyResult) : undefined;
	}
}
