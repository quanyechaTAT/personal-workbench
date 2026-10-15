import type { SQLInputValue } from "node:sqlite";
import type {
	MemoryWriteIntent,
	SemanticMemory,
	SemanticQuery,
	SemanticRepository,
} from "@earendil-works/workbench-core";
import { WorkbenchError } from "@earendil-works/workbench-core";
import type { WorkbenchDatabase } from "./database.ts";
import { knowledgeTerms } from "./knowledge-repository.ts";

interface Row {
	data_json: string;
}
function filter(query: SemanticQuery): { clause: string; values: SQLInputValue[] } {
	const clauses = [query.projectId ? "(m.project_id IS NULL OR m.project_id = ?)" : "m.project_id IS NULL"];
	const values: SQLInputValue[] = query.projectId ? [query.projectId] : [];
	if (query.minConfidence !== undefined) {
		clauses.push(
			"COALESCE(json_extract(m.data_json, '$.confidence'), CASE m.confirmation WHEN 'user_confirmed' THEN 1.0 WHEN 'verified' THEN 0.85 ELSE 0.4 END) >= ?",
		);
		values.push(query.minConfidence);
	}
	if (query.kind) {
		clauses.push("m.kind = ?");
		values.push(query.kind);
	}
	if (query.activeOnly !== false) {
		clauses.push("m.status = 'active' AND m.valid_from <= ? AND (m.valid_until IS NULL OR m.valid_until > ?)");
		values.push(query.at, query.at);
	}
	return { clause: clauses.join(" AND "), values };
}
export class SqliteSemanticRepository implements SemanticRepository {
	private readonly database: WorkbenchDatabase;
	constructor(database: WorkbenchDatabase) {
		this.database = database;
	}
	async saveWriteIntent(value: MemoryWriteIntent): Promise<void> {
		this.database
			.prepare("INSERT INTO memory_write_intents VALUES (?, ?, ?, ?)")
			.run(value.id, value.status, value.createdAt, JSON.stringify(value));
	}
	async listWriteIntents(): Promise<MemoryWriteIntent[]> {
		const rows = this.database
			.prepare("SELECT data_json FROM memory_write_intents WHERE status = 'prepared' ORDER BY created_at, id")
			.all() as unknown as Row[];
		return rows.map((row) => JSON.parse(row.data_json) as MemoryWriteIntent);
	}
	async finishWriteIntent(id: string, status: "applied" | "conflicted"): Promise<void> {
		this.database
			.prepare(
				"UPDATE memory_write_intents SET status = ?, data_json = json_set(data_json, '$.status', ?) WHERE id = ?",
			)
			.run(status, status, id);
	}
	async replaceSemantics(path: string, values: SemanticMemory[]): Promise<void> {
		this.database.transaction(() => {
			const old = this.database
				.prepare("SELECT id, version FROM semantic_memories WHERE relative_path = ?")
				.all(path) as unknown as Array<{ id: string; version: number }>;
			for (const record of old)
				if (!values.some((value) => value.id === record.id))
					this.database.prepare("DELETE FROM semantic_memories WHERE id = ?").run(record.id);
			for (const value of values) {
				const json = JSON.stringify(value);
				this.database
					.prepare("INSERT INTO semantic_versions VALUES (?, ?, ?) ON CONFLICT(id, version) DO NOTHING")
					.run(value.id, value.version, json);
				this.database
					.prepare(
						"INSERT INTO semantic_memories VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET project_id = excluded.project_id, kind = excluded.kind, relative_path = excluded.relative_path, text = excluded.text, version = excluded.version, status = excluded.status, confirmation = excluded.confirmation, valid_from = excluded.valid_from, valid_until = excluded.valid_until, data_json = excluded.data_json",
					)
					.run(
						value.id,
						value.projectId ?? null,
						value.kind,
						path,
						value.text,
						value.version,
						value.status,
						value.confirmation,
						value.validFrom,
						value.validUntil ?? null,
						json,
					);
				this.database
					.prepare("DELETE FROM semantic_vectors WHERE id = ? AND version <> ?")
					.run(value.id, value.version);
			}
		});
	}
	async getSemantic(id: string): Promise<SemanticMemory | undefined> {
		const row = this.database.prepare("SELECT data_json FROM semantic_memories WHERE id = ?").get(id) as
			| Row
			| undefined;
		return row ? (JSON.parse(row.data_json) as SemanticMemory) : undefined;
	}
	async relocateProjectFile(projectId: string, from: string, to: string): Promise<void> {
		this.database.transaction(() => {
			this.database
				.prepare(
					"UPDATE semantic_memories SET relative_path = ?, data_json = json_set(data_json, '$.relativePath', ?) WHERE project_id = ? AND kind = 'project' AND relative_path = ?",
				)
				.run(to, to, projectId, from);
			this.database
				.prepare(
					"UPDATE semantic_versions SET data_json = json_set(data_json, '$.relativePath', ?) WHERE json_extract(data_json, '$.projectId') = ? AND json_extract(data_json, '$.kind') = 'project' AND json_extract(data_json, '$.relativePath') = ?",
				)
				.run(to, projectId, from);
			this.database
				.prepare(
					"UPDATE memory_candidates SET status = 'conflicted' WHERE project_id = ? AND relative_path = ? AND status = 'pending'",
				)
				.run(projectId, from);
		});
	}
	async listSemantics(query: SemanticQuery): Promise<SemanticMemory[]> {
		const scope = filter(query);
		const terms = query.query ? knowledgeTerms(query.query, 32) : [];
		const condition = terms.length ? ` AND (${terms.map(() => "m.text LIKE ? ESCAPE '\\'").join(" OR ")})` : "";
		const rows = this.database
			.prepare(
				`SELECT m.data_json FROM semantic_memories m WHERE ${scope.clause}${condition} ORDER BY CASE m.confirmation WHEN 'user_confirmed' THEN 0 WHEN 'verified' THEN 1 ELSE 2 END, m.version DESC, m.id LIMIT ?`,
			)
			.all(
				...scope.values,
				...terms.map((term) => `%${term.replace(/[\\%_]/g, "\\$&")}%`),
				Math.max(1, Math.min(10000, query.limit ?? 50)),
			) as unknown as Row[];
		return rows.map((row) => JSON.parse(row.data_json) as SemanticMemory);
	}
	async semanticHistory(id: string): Promise<SemanticMemory[]> {
		const rows = this.database
			.prepare("SELECT data_json FROM semantic_versions WHERE id = ? ORDER BY version DESC")
			.all(id) as unknown as Row[];
		return rows.map((row) => JSON.parse(row.data_json) as SemanticMemory);
	}
	async saveSemanticVector(id: string, version: number, fingerprint: string, vector: number[]): Promise<void> {
		if (!vector.length || vector.length > 8192 || !vector.every(Number.isFinite))
			throw new WorkbenchError("invalid_input", "记忆向量无效");
		this.database
			.prepare(
				"INSERT INTO semantic_vectors SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM semantic_memories WHERE id = ? AND version = ?) ON CONFLICT(id) DO UPDATE SET version = excluded.version, space_id = excluded.space_id, dimension = excluded.dimension, embedding = excluded.embedding",
			)
			.run(id, version, fingerprint, vector.length, new Uint8Array(new Float32Array(vector).buffer), id, version);
	}
	async searchSemanticVectors(query: SemanticQuery, fingerprint: string, vector: number[]): Promise<SemanticMemory[]> {
		const scope = filter(query);
		if (
			this.database
				.prepare(
					`SELECT 1 FROM semantic_vectors v JOIN semantic_memories m ON m.id = v.id AND m.version = v.version WHERE ${scope.clause} AND v.space_id = ? AND v.dimension <> ? LIMIT 1`,
				)
				.get(...scope.values, fingerprint, vector.length)
		)
			throw new WorkbenchError("conflict", "记忆向量维度已改变，请重建索引");
		const rows = this.database
			.prepare(
				`SELECT m.data_json FROM semantic_memories m JOIN semantic_vectors v ON m.id = v.id AND m.version = v.version WHERE ${scope.clause} AND v.space_id = ? AND v.dimension = ? ORDER BY vec_distance_cosine(v.embedding, ?) LIMIT ?`,
			)
			.all(
				...scope.values,
				fingerprint,
				vector.length,
				new Uint8Array(new Float32Array(vector).buffer),
				query.limit ?? 10,
			) as unknown as Row[];
		return rows.map((row) => JSON.parse(row.data_json) as SemanticMemory);
	}
}
