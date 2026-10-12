import type { ActivityRecord, ActivityRepository } from "@earendil-works/workbench-core";
import type { WorkbenchDatabase } from "./database.ts";

interface ActivityRow {
	id: string;
	project_id: string | null;
	session_id: string | null;
	run_id: string | null;
	type: string;
	summary: string;
	metadata_json: string;
	created_at: string;
}

function mapActivity(row: ActivityRow): ActivityRecord {
	return {
		id: row.id,
		projectId: row.project_id ?? undefined,
		sessionId: row.session_id ?? undefined,
		runId: row.run_id ?? undefined,
		type: row.type,
		summary: row.summary,
		metadata: JSON.parse(row.metadata_json) as ActivityRecord["metadata"],
		createdAt: row.created_at,
	};
}

export class SqliteActivityRepository implements ActivityRepository {
	private readonly database: WorkbenchDatabase;

	constructor(database: WorkbenchDatabase) {
		this.database = database;
	}

	async create(activity: ActivityRecord): Promise<ActivityRecord> {
		this.database
			.prepare(
				`INSERT INTO activity(
          id, project_id, session_id, run_id, type, summary, metadata_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				activity.id,
				activity.projectId ?? null,
				activity.sessionId ?? null,
				activity.runId ?? null,
				activity.type,
				activity.summary,
				JSON.stringify(activity.metadata),
				activity.createdAt,
			);
		return activity;
	}

	async list(filter: { projectId?: string; sessionId?: string; limit?: number } = {}): Promise<ActivityRecord[]> {
		const conditions: string[] = [];
		const values: Array<string | number> = [];
		if (filter.projectId) {
			conditions.push("project_id = ?");
			values.push(filter.projectId);
		}
		if (filter.sessionId) {
			conditions.push("session_id = ?");
			values.push(filter.sessionId);
		}
		const limit = Math.min(100, Math.max(1, Math.trunc(filter.limit ?? 20)));
		values.push(limit);
		const where = conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : "";
		const rows = this.database
			.prepare(`SELECT * FROM activity${where} ORDER BY created_at DESC LIMIT ?`)
			.all(...values) as unknown as ActivityRow[];
		return rows.map(mapActivity);
	}
}
