import type { Artifact, ArtifactRepository } from "@earendil-works/workbench-core";
import type { WorkbenchDatabase } from "./database.ts";

interface ArtifactRow {
	id: string;
	project_id: string | null;
	session_id: string | null;
	task_run_id: string | null;
	type: Artifact["type"];
	name: string;
	file_path: string;
	relative_path: string;
	mime_type: string;
	size: number;
	sha256: string;
	tool_call_id: string | null;
	idempotency_key: string | null;
	created_at: string;
}

function mapArtifact(row: ArtifactRow): Artifact {
	return {
		id: row.id,
		projectId: row.project_id ?? undefined,
		sessionId: row.session_id ?? undefined,
		taskRunId: row.task_run_id ?? undefined,
		type: row.type,
		name: row.name,
		filePath: row.file_path,
		relativePath: row.relative_path,
		mimeType: row.mime_type,
		size: row.size,
		sha256: row.sha256,
		toolCallId: row.tool_call_id ?? undefined,
		idempotencyKey: row.idempotency_key ?? undefined,
		createdAt: row.created_at,
	};
}

export class SqliteArtifactRepository implements ArtifactRepository {
	private readonly database: WorkbenchDatabase;

	constructor(database: WorkbenchDatabase) {
		this.database = database;
	}

	async getByIdempotencyKey(key: string): Promise<Artifact | undefined> {
		const row = this.database.prepare("SELECT * FROM artifacts WHERE idempotency_key = ?").get(key) as
			| ArtifactRow
			| undefined;
		return row ? mapArtifact(row) : undefined;
	}

	async create(artifact: Artifact): Promise<Artifact> {
		this.database
			.prepare(
				`INSERT INTO artifacts(
          id, project_id, session_id, task_run_id, type, name, file_path, relative_path,
          mime_type, size, sha256, tool_call_id, idempotency_key, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				artifact.id,
				artifact.projectId ?? null,
				artifact.sessionId ?? null,
				artifact.taskRunId ?? null,
				artifact.type,
				artifact.name,
				artifact.filePath,
				artifact.relativePath,
				artifact.mimeType,
				artifact.size,
				artifact.sha256,
				artifact.toolCallId ?? null,
				artifact.idempotencyKey ?? null,
				artifact.createdAt,
			);
		return artifact;
	}

	async list(projectId?: string): Promise<Artifact[]> {
		const rows = projectId
			? (this.database
					.prepare("SELECT * FROM artifacts WHERE project_id = ? ORDER BY created_at DESC")
					.all(projectId) as unknown as ArtifactRow[])
			: (this.database
					.prepare("SELECT * FROM artifacts ORDER BY created_at DESC")
					.all() as unknown as ArtifactRow[]);
		return rows.map(mapArtifact);
	}
}
