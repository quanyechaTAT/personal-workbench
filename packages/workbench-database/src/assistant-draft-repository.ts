import type { AssistantDraft, AssistantDraftRepository, AssistantDraftStatus } from "@earendil-works/workbench-core";
import type { WorkbenchDatabase } from "./database.ts";

interface DraftRow {
	id: string;
	requirement: string;
	status: AssistantDraftStatus;
	config_json: string | null;
	model_json: string | null;
	error_message: string | null;
	version: number;
	created_profile_id: string | null;
	created_at: string;
	updated_at: string;
}

function mapDraft(row: DraftRow): AssistantDraft {
	return {
		id: row.id,
		requirement: row.requirement,
		status: row.status,
		config: row.config_json ? (JSON.parse(row.config_json) as AssistantDraft["config"]) : undefined,
		model: row.model_json ? (JSON.parse(row.model_json) as AssistantDraft["model"]) : undefined,
		errorMessage: row.error_message ?? undefined,
		version: row.version,
		createdProfileId: row.created_profile_id ?? undefined,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

export class SqliteAssistantDraftRepository implements AssistantDraftRepository {
	private readonly database: WorkbenchDatabase;

	constructor(database: WorkbenchDatabase) {
		this.database = database;
	}

	async create(value: AssistantDraft): Promise<AssistantDraft> {
		this.database
			.prepare(
				`INSERT INTO assistant_drafts(
          id, requirement, status, config_json, model_json, error_message, version,
          created_profile_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(...this.values(value));
		return value;
	}

	async get(id: string): Promise<AssistantDraft | undefined> {
		const row = this.database.prepare("SELECT * FROM assistant_drafts WHERE id = ?").get(id) as DraftRow | undefined;
		return row ? mapDraft(row) : undefined;
	}

	async update(value: AssistantDraft, expectedVersion: number): Promise<AssistantDraft | undefined> {
		const result = this.database
			.prepare(
				`UPDATE assistant_drafts SET requirement = ?, status = ?, config_json = ?, model_json = ?,
         error_message = ?, version = ?, created_profile_id = ?, updated_at = ? WHERE id = ? AND version = ?`,
			)
			.run(
				value.requirement,
				value.status,
				value.config ? JSON.stringify(value.config) : null,
				value.model ? JSON.stringify(value.model) : null,
				value.errorMessage ?? null,
				value.version,
				value.createdProfileId ?? null,
				value.updatedAt,
				value.id,
				expectedVersion,
			);
		return result.changes === 1 ? value : undefined;
	}

	async list(status?: AssistantDraftStatus): Promise<AssistantDraft[]> {
		const rows = (status
			? this.database.prepare("SELECT * FROM assistant_drafts WHERE status = ? ORDER BY updated_at DESC").all(status)
			: this.database
					.prepare("SELECT * FROM assistant_drafts ORDER BY updated_at DESC")
					.all()) as unknown as DraftRow[];
		return rows.map(mapDraft);
	}

	private values(value: AssistantDraft): Array<string | number | null> {
		return [
			value.id,
			value.requirement,
			value.status,
			value.config ? JSON.stringify(value.config) : null,
			value.model ? JSON.stringify(value.model) : null,
			value.errorMessage ?? null,
			value.version,
			value.createdProfileId ?? null,
			value.createdAt,
			value.updatedAt,
		];
	}
}
