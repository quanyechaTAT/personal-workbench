import type { JsonValue, SettingRecord, SettingsRepository } from "@earendil-works/workbench-core";
import type { WorkbenchDatabase } from "./database.ts";

interface SettingRow {
	key: string;
	value_json: string;
	version: number;
	updated_at: string;
}

function mapSetting(row: SettingRow): SettingRecord {
	return {
		key: row.key,
		value: JSON.parse(row.value_json) as JsonValue,
		version: row.version,
		updatedAt: row.updated_at,
	};
}

export class SqliteSettingsRepository implements SettingsRepository {
	private readonly database: WorkbenchDatabase;

	constructor(database: WorkbenchDatabase) {
		this.database = database;
	}

	async get(key: string): Promise<SettingRecord | undefined> {
		const row = this.database.prepare("SELECT * FROM settings WHERE key = ?").get(key) as SettingRow | undefined;
		return row ? mapSetting(row) : undefined;
	}

	async set(record: SettingRecord, expectedVersion?: number): Promise<SettingRecord | undefined> {
		if (expectedVersion === undefined) {
			this.database
				.prepare(
					`INSERT INTO settings(key, value_json, version, updated_at) VALUES (?, ?, ?, ?)
             ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, version = excluded.version, updated_at = excluded.updated_at`,
				)
				.run(record.key, JSON.stringify(record.value), record.version, record.updatedAt);
			return record;
		}
		const result = this.database
			.prepare("UPDATE settings SET value_json = ?, version = ?, updated_at = ? WHERE key = ? AND version = ?")
			.run(JSON.stringify(record.value), record.version, record.updatedAt, record.key, expectedVersion);
		return result.changes === 1 ? record : undefined;
	}

	async list(): Promise<SettingRecord[]> {
		return (this.database.prepare("SELECT * FROM settings ORDER BY key").all() as unknown as SettingRow[]).map(
			mapSetting,
		);
	}
}
