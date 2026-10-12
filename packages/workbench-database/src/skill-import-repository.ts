import type { SkillImport, SkillImportRepository, WorkbenchSkill } from "@earendil-works/workbench-core";
import type { WorkbenchDatabase } from "./database.ts";
import { SqliteSkillRepository } from "./skill-repository.ts";

interface SkillImportRow {
	id: string;
	source: SkillImport["source"];
	source_location: string;
	source_ref: string | null;
	source_commit: string | null;
	source_subdirectory: string | null;
	scope: SkillImport["scope"];
	project_id: string | null;
	staging_path: string;
	candidates_json: string;
	status: SkillImport["status"];
	error_message: string | null;
	created_at: string;
	updated_at: string;
}

function mapImport(row: SkillImportRow): SkillImport {
	return {
		id: row.id,
		source: row.source,
		sourceLocation: row.source_location,
		sourceRef: row.source_ref ?? undefined,
		sourceCommit: row.source_commit ?? undefined,
		sourceSubdirectory: row.source_subdirectory ?? undefined,
		scope: row.scope,
		projectId: row.project_id ?? undefined,
		stagingPath: row.staging_path,
		candidates: JSON.parse(row.candidates_json) as SkillImport["candidates"],
		status: row.status,
		errorMessage: row.error_message ?? undefined,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

export class SqliteSkillImportRepository implements SkillImportRepository {
	private readonly database: WorkbenchDatabase;

	constructor(database: WorkbenchDatabase) {
		this.database = database;
	}

	async create(value: SkillImport): Promise<SkillImport> {
		this.database
			.prepare(
				`INSERT INTO skill_imports(
          id, source, source_location, source_ref, source_commit, source_subdirectory, scope, project_id,
          staging_path, candidates_json, status, error_message, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(...this.values(value));
		return value;
	}

	async get(id: string): Promise<SkillImport | undefined> {
		const row = this.database.prepare("SELECT * FROM skill_imports WHERE id = ?").get(id) as
			| SkillImportRow
			| undefined;
		return row ? mapImport(row) : undefined;
	}

	async update(value: SkillImport): Promise<SkillImport> {
		return this.updateSync(value);
	}

	async commit(value: SkillImport, skills: WorkbenchSkill[]): Promise<SkillImport> {
		return this.database.transaction(() => {
			const repository = new SqliteSkillRepository(this.database);
			for (const skill of skills) repository.upsertSync(skill);
			return this.updateSync(value);
		});
	}

	private updateSync(value: SkillImport): SkillImport {
		this.database
			.prepare(
				`UPDATE skill_imports SET source = ?, source_location = ?, source_ref = ?, source_commit = ?,
         source_subdirectory = ?, scope = ?, project_id = ?, staging_path = ?, candidates_json = ?,
         status = ?, error_message = ?, created_at = ?, updated_at = ? WHERE id = ?`,
			)
			.run(...this.values(value).slice(1), value.id);
		return value;
	}

	async list(status?: SkillImport["status"]): Promise<SkillImport[]> {
		const rows = (status
			? this.database.prepare("SELECT * FROM skill_imports WHERE status = ? ORDER BY created_at DESC").all(status)
			: this.database
					.prepare("SELECT * FROM skill_imports ORDER BY created_at DESC")
					.all()) as unknown as SkillImportRow[];
		return rows.map(mapImport);
	}

	private values(value: SkillImport): Array<string | null> {
		return [
			value.id,
			value.source,
			value.sourceLocation,
			value.sourceRef ?? null,
			value.sourceCommit ?? null,
			value.sourceSubdirectory ?? null,
			value.scope,
			value.projectId ?? null,
			value.stagingPath,
			JSON.stringify(value.candidates),
			value.status,
			value.errorMessage ?? null,
			value.createdAt,
			value.updatedAt,
		];
	}
}
