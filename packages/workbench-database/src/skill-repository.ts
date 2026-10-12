import type { SkillRepository, SkillScope, WorkbenchSkill } from "@earendil-works/workbench-core";
import type { WorkbenchDatabase } from "./database.ts";

interface SkillRow {
	id: string;
	slug: string;
	name: string;
	description: string;
	scope: SkillScope;
	project_id: string | null;
	enabled: number;
	path: string;
	source_hash: string;
	imported_hash: string | null;
	is_builtin: number;
	source_kind: WorkbenchSkill["sourceKind"];
	source_url: string | null;
	source_ref: string | null;
	source_commit: string | null;
	source_subdirectory: string | null;
	diagnostics_json: string;
	created_at: string;
	updated_at: string;
}

function mapSkill(row: SkillRow): WorkbenchSkill {
	return {
		id: row.id,
		slug: row.slug,
		name: row.name,
		description: row.description,
		scope: row.scope,
		projectId: row.project_id ?? undefined,
		enabled: row.enabled === 1,
		path: row.path,
		sourceHash: row.source_hash,
		importedHash: row.imported_hash ?? undefined,
		isBuiltin: row.is_builtin === 1,
		sourceKind: row.source_kind,
		sourceUrl: row.source_url ?? undefined,
		sourceRef: row.source_ref ?? undefined,
		sourceCommit: row.source_commit ?? undefined,
		sourceSubdirectory: row.source_subdirectory ?? undefined,
		diagnostics: JSON.parse(row.diagnostics_json) as string[],
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

export class SqliteSkillRepository implements SkillRepository {
	private readonly database: WorkbenchDatabase;

	constructor(database: WorkbenchDatabase) {
		this.database = database;
	}

	async upsert(skill: WorkbenchSkill): Promise<WorkbenchSkill> {
		return this.upsertSync(skill);
	}

	upsertSync(skill: WorkbenchSkill): WorkbenchSkill {
		this.database
			.prepare(
				`INSERT INTO skills(
          id, slug, name, description, scope, project_id, enabled, path, source_hash, is_builtin,
          source_kind, source_url, source_ref, source_commit, source_subdirectory, diagnostics_json,
          created_at, updated_at, imported_hash
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT DO UPDATE SET
          name = excluded.name, description = excluded.description, enabled = excluded.enabled,
          path = excluded.path, source_hash = excluded.source_hash, is_builtin = excluded.is_builtin,
          source_kind = excluded.source_kind, source_url = excluded.source_url,
          source_ref = excluded.source_ref, source_commit = excluded.source_commit,
          source_subdirectory = excluded.source_subdirectory, diagnostics_json = excluded.diagnostics_json,
          updated_at = excluded.updated_at, imported_hash = excluded.imported_hash`,
			)
			.run(
				skill.id,
				skill.slug,
				skill.name,
				skill.description,
				skill.scope,
				skill.projectId ?? null,
				skill.enabled ? 1 : 0,
				skill.path,
				skill.sourceHash,
				skill.isBuiltin ? 1 : 0,
				skill.sourceKind,
				skill.sourceUrl ?? null,
				skill.sourceRef ?? null,
				skill.sourceCommit ?? null,
				skill.sourceSubdirectory ?? null,
				JSON.stringify(skill.diagnostics),
				skill.createdAt,
				skill.updatedAt,
				skill.importedHash ?? null,
			);
		const stored = this.database
			.prepare("SELECT * FROM skills WHERE slug = ? AND scope = ? AND project_id IS ?")
			.get(skill.slug, skill.scope, skill.projectId ?? null) as SkillRow | undefined;
		return stored ? mapSkill(stored) : skill;
	}

	async get(id: string): Promise<WorkbenchSkill | undefined> {
		const row = this.database.prepare("SELECT * FROM skills WHERE id = ?").get(id) as SkillRow | undefined;
		return row ? mapSkill(row) : undefined;
	}

	async list(filter: { scope?: SkillScope; projectId?: string } = {}): Promise<WorkbenchSkill[]> {
		let rows: SkillRow[];
		if (filter.scope && filter.projectId) {
			rows = this.database
				.prepare("SELECT * FROM skills WHERE scope = ? AND project_id = ? ORDER BY name")
				.all(filter.scope, filter.projectId) as unknown as SkillRow[];
		} else if (filter.scope === "global") {
			rows = this.database
				.prepare("SELECT * FROM skills WHERE scope = 'global' AND project_id IS NULL ORDER BY name")
				.all() as unknown as SkillRow[];
		} else if (filter.scope) {
			rows = this.database
				.prepare("SELECT * FROM skills WHERE scope = ? ORDER BY name")
				.all(filter.scope) as unknown as SkillRow[];
		} else {
			rows = this.database.prepare("SELECT * FROM skills ORDER BY name").all() as unknown as SkillRow[];
		}
		return rows.map(mapSkill);
	}

	async setEnabled(id: string, enabled: boolean, updatedAt: string): Promise<WorkbenchSkill | undefined> {
		const result = this.database
			.prepare("UPDATE skills SET enabled = ?, updated_at = ? WHERE id = ?")
			.run(enabled ? 1 : 0, updatedAt, id);
		return result.changes === 1 ? this.get(id) : undefined;
	}
}
