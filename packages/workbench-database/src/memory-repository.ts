import type {
	MemoryCandidate,
	MemoryCandidateStatus,
	MemoryFileRecord,
	MemoryIndexEntry,
	MemoryKind,
	MemoryRepository,
	MemorySearchResult,
	SemanticChange,
} from "@earendil-works/workbench-core";
import type { WorkbenchDatabase } from "./database.ts";

interface CandidateRow {
	semantic_json: string | null;
	id: string;
	kind: MemoryKind;
	project_id: string | null;
	relative_path: string;
	heading: string | null;
	proposed_text: string;
	reason: string;
	preview: string;
	base_hash: string;
	applied_hash: string | null;
	status: MemoryCandidateStatus;
	session_id: string | null;
	run_id: string | null;
	tool_call_id: string | null;
	idempotency_key: string | null;
	created_at: string;
	updated_at: string;
	resolved_at: string | null;
}

interface SearchRow {
	id: string;
	project_id: string | null;
	kind: MemoryKind;
	heading: string | null;
	start_line: number;
	end_line: number;
	content: string;
	content_hash: string;
	relative_path: string;
	rank?: number;
}

interface MemoryFileRow {
	id: string;
	kind: MemoryKind;
	project_id: string | null;
	relative_path: string;
	content_hash: string;
	size: number;
	modified_at: string | null;
	indexed_at: string;
	version: number;
}

function mapMemoryFile(row: MemoryFileRow): MemoryFileRecord {
	return {
		id: row.id,
		kind: row.kind,
		projectId: row.project_id ?? undefined,
		relativePath: row.relative_path,
		contentHash: row.content_hash,
		size: row.size,
		modifiedAt: row.modified_at ?? undefined,
		indexedAt: row.indexed_at,
		version: row.version,
	};
}

function mapCandidate(row: CandidateRow): MemoryCandidate {
	return {
		semanticChange: row.semantic_json ? (JSON.parse(row.semantic_json) as SemanticChange) : undefined,
		id: row.id,
		kind: row.kind,
		projectId: row.project_id ?? undefined,
		relativePath: row.relative_path,
		heading: row.heading ?? undefined,
		proposedText: row.proposed_text,
		reason: row.reason,
		preview: row.preview,
		baseHash: row.base_hash,
		appliedHash: row.applied_hash ?? undefined,
		status: row.status,
		sessionId: row.session_id ?? undefined,
		runId: row.run_id ?? undefined,
		toolCallId: row.tool_call_id ?? undefined,
		idempotencyKey: row.idempotency_key ?? undefined,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		resolvedAt: row.resolved_at ?? undefined,
	};
}

function candidateValues(candidate: MemoryCandidate): Array<string | null> {
	return [
		candidate.id,
		candidate.kind,
		candidate.projectId ?? null,
		candidate.relativePath,
		candidate.heading ?? null,
		candidate.proposedText,
		candidate.reason,
		candidate.preview,
		candidate.baseHash,
		candidate.appliedHash ?? null,
		candidate.status,
		candidate.sessionId ?? null,
		candidate.runId ?? null,
		candidate.toolCallId ?? null,
		candidate.idempotencyKey ?? null,
		candidate.createdAt,
		candidate.updatedAt,
		candidate.resolvedAt ?? null,
		candidate.semanticChange ? JSON.stringify(candidate.semanticChange) : null,
	];
}

function kindBonus(kind: MemoryKind): number {
	switch (kind) {
		case "project":
			return 8;
		case "user":
			return 6;
		case "global":
			return 4;
		case "daily":
			return 2;
	}
}

export class SqliteMemoryRepository implements MemoryRepository {
	private readonly database: WorkbenchDatabase;

	constructor(database: WorkbenchDatabase) {
		this.database = database;
	}

	async listFiles(): Promise<MemoryFileRecord[]> {
		return (
			this.database
				.prepare("SELECT * FROM memory_files ORDER BY kind, relative_path")
				.all() as unknown as MemoryFileRow[]
		).map(mapMemoryFile);
	}

	async deleteFile(kind: MemoryKind, projectId: string | undefined, relativePath: string): Promise<void> {
		this.database
			.prepare("DELETE FROM memory_files WHERE kind = ? AND ifnull(project_id, '') = ? AND relative_path = ?")
			.run(kind, projectId ?? "", relativePath);
	}

	async getCandidate(id: string): Promise<MemoryCandidate | undefined> {
		return this.getCandidateWhere("id = ?", id);
	}

	async getCandidateByIdempotencyKey(key: string): Promise<MemoryCandidate | undefined> {
		return this.getCandidateWhere("idempotency_key = ?", key);
	}

	async listCandidates(status?: MemoryCandidateStatus): Promise<MemoryCandidate[]> {
		const rows = status
			? (this.database
					.prepare("SELECT * FROM memory_candidates WHERE status = ? ORDER BY created_at DESC")
					.all(status) as unknown as CandidateRow[])
			: (this.database
					.prepare("SELECT * FROM memory_candidates ORDER BY created_at DESC")
					.all() as unknown as CandidateRow[]);
		return rows.map(mapCandidate);
	}

	async createCandidate(candidate: MemoryCandidate): Promise<MemoryCandidate> {
		this.database
			.prepare(
				`INSERT INTO memory_candidates(
          id, kind, project_id, relative_path, heading, proposed_text, reason, preview, base_hash,
          applied_hash, status, session_id, run_id, tool_call_id, idempotency_key, created_at, updated_at, resolved_at, semantic_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(...candidateValues(candidate));
		return candidate;
	}

	async updateCandidate(candidate: MemoryCandidate): Promise<MemoryCandidate> {
		this.updateCandidateSync(candidate);
		return candidate;
	}

	async replaceFileIndex(file: MemoryFileRecord, entries: MemoryIndexEntry[]): Promise<void> {
		this.database.transaction(() => this.replaceFileIndexSync(file, entries));
	}

	async completeCandidate(
		candidate: MemoryCandidate,
		file: MemoryFileRecord,
		entries: MemoryIndexEntry[],
	): Promise<void> {
		this.database.transaction(() => {
			this.replaceFileIndexSync(file, entries);
			this.updateCandidateSync(candidate);
		});
	}

	async search(
		query: string,
		scope: { projectId?: string; kinds: MemoryKind[]; limit: number },
	): Promise<MemorySearchResult[]> {
		const rows = new Map<string, { row: SearchRow; score: number }>();
		if (!scope.kinds.length) return [];
		const scoped = `mi.kind IN (${scope.kinds.map(() => "?").join(",")}) AND (mi.kind <> 'project' OR mi.project_id = ?)`;
		const scopedValues = [...scope.kinds, scope.projectId ?? ""];
		const ftsQuery = `"${query.replaceAll('"', '""')}"`;
		try {
			const ftsRows = this.database
				.prepare(
					`SELECT mi.*, mf.relative_path, bm25(memory_index_fts) AS rank
             FROM memory_index_fts
             JOIN memory_index mi ON mi.rowid = memory_index_fts.rowid
             JOIN memory_files mf ON mf.id = mi.memory_file_id
             WHERE memory_index_fts MATCH ? AND ${scoped}
             LIMIT 500`,
				)
				.all(ftsQuery, ...scopedValues) as unknown as SearchRow[];
			for (const row of ftsRows) rows.set(row.id, { row, score: 50 - (row.rank ?? 0) + kindBonus(row.kind) });
		} catch (error) {
			void error;
			// LIKE below remains authoritative for literal queries that FTS syntax cannot represent.
		}
		const escaped = query.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
		const likeRows = this.database
			.prepare(
				`SELECT mi.*, mf.relative_path
           FROM memory_index mi
           JOIN memory_files mf ON mf.id = mi.memory_file_id
           WHERE (lower(mi.content) LIKE lower(?) ESCAPE '\\'
              OR lower(ifnull(mi.heading, '')) LIKE lower(?) ESCAPE '\\') AND ${scoped}
           LIMIT 500`,
			)
			.all(`%${escaped}%`, `%${escaped}%`, ...scopedValues) as unknown as SearchRow[];
		for (const row of likeRows) {
			const existing = rows.get(row.id);
			const exactScore = row.content.toLocaleLowerCase().includes(query.toLocaleLowerCase()) ? 100 : 70;
			rows.set(row.id, { row, score: Math.max(existing?.score ?? 0, exactScore + kindBonus(row.kind)) });
		}
		const allowedKinds = new Set(scope.kinds);
		return [...rows.values()]
			.filter(({ row }) => allowedKinds.has(row.kind))
			.filter(({ row }) => row.kind !== "project" || row.project_id === scope.projectId)
			.sort((left, right) => right.score - left.score)
			.slice(0, scope.limit)
			.map(({ row, score }) => ({
				memoryId: row.id,
				kind: row.kind,
				projectId: row.project_id ?? undefined,
				relativePath: row.relative_path,
				startLine: row.start_line,
				endLine: row.end_line,
				heading: row.heading ?? undefined,
				snippet: row.content,
				contentHash: row.content_hash,
				score,
			}));
	}

	private async getCandidateWhere(clause: string, value: string): Promise<MemoryCandidate | undefined> {
		const row = this.database.prepare(`SELECT * FROM memory_candidates WHERE ${clause}`).get(value) as
			| CandidateRow
			| undefined;
		return row ? mapCandidate(row) : undefined;
	}

	private updateCandidateSync(candidate: MemoryCandidate): void {
		this.database
			.prepare(
				`UPDATE memory_candidates SET
          kind = ?, project_id = ?, relative_path = ?, heading = ?, proposed_text = ?, reason = ?, preview = ?,
          base_hash = ?, applied_hash = ?, status = ?, session_id = ?, run_id = ?, tool_call_id = ?,
          idempotency_key = ?, created_at = ?, updated_at = ?, resolved_at = ?, semantic_json = ?
        WHERE id = ?`,
			)
			.run(...candidateValues(candidate).slice(1), candidate.id);
	}

	private replaceFileIndexSync(file: MemoryFileRecord, entries: MemoryIndexEntry[]): void {
		this.database
			.prepare(
				`INSERT INTO memory_files(
          id, kind, project_id, relative_path, content_hash, size, modified_at, indexed_at, version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          kind = excluded.kind, project_id = excluded.project_id, relative_path = excluded.relative_path,
          content_hash = excluded.content_hash, size = excluded.size, modified_at = excluded.modified_at,
          indexed_at = excluded.indexed_at, version = memory_files.version + 1`,
			)
			.run(
				file.id,
				file.kind,
				file.projectId ?? null,
				file.relativePath,
				file.contentHash,
				file.size,
				file.modifiedAt ?? null,
				file.indexedAt,
				file.version,
			);
		this.database.prepare("DELETE FROM memory_index WHERE memory_file_id = ?").run(file.id);
		const insert = this.database.prepare(
			`INSERT INTO memory_index(
        id, memory_file_id, project_id, kind, heading, start_line, end_line, content, content_hash, occurred_on, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		);
		for (const entry of entries) {
			insert.run(
				entry.id,
				entry.memoryFileId,
				entry.projectId ?? null,
				entry.kind,
				entry.heading ?? null,
				entry.startLine,
				entry.endLine,
				entry.content,
				entry.contentHash,
				entry.occurredOn ?? null,
				entry.createdAt,
			);
		}
	}
}
