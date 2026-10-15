import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { type DatabaseSync, DatabaseSync as NodeDatabaseSync, type StatementSync } from "node:sqlite";
import { WorkbenchError } from "@earendil-works/workbench-core";
import { load as loadVectorExtension } from "sqlite-vec";

interface Migration {
	version: number;
	name: string;
	sql: string;
	checksum: string;
}

interface MigrationRow {
	version: number;
	name: string;
	checksum: string;
}

function loadMigrations(): Migration[] {
	return [
		"001_initial",
		"002_assistants",
		"003_mcp_connections",
		"004_skill_imports",
		"005_assistant_drafts",
		"006_mcp_binding_stability",
		"007_skill_baselines",
		"008_session_model_override",
		"009_profile_binding_diagnostics",
		"010_mcp_tool_diagnostics",
		"011_session_lifecycle",
		"012_project_sources_tasks",
		"013_session_thinking",
		"014_project_knowledge",
		"015_knowledge_documents",
		"016_assistant_deletion",
		"017_project_learning",
		"018_structured_knowledge",
		"019_memory_state",
		"020_semantic_memory",
		"021_perceptual_memory",
		"022_episode_vectors",
		"023_canonical_workspace_documents",
		"024_learning_loop",
		"025_learning_cadence",
		"026_background_learning",
		"027_project_deletion",
		"028_memory_lifecycle",
	].map((name, index) => {
		const sql = readFileSync(new URL(`./migrations/${name}.sql`, import.meta.url), "utf8");
		return { version: index + 1, name, sql, checksum: createHash("sha256").update(sql).digest("hex") };
	});
}

export class WorkbenchDatabase {
	private readonly database: DatabaseSync;
	private closed = false;

	constructor(path: string) {
		mkdirSync(dirname(path), { recursive: true });
		this.database = new NodeDatabaseSync(path, { allowExtension: true });
		try {
			loadVectorExtension(this.database);
			this.database.enableLoadExtension(false);
			this.database.exec("PRAGMA foreign_keys = ON");
			this.database.exec("PRAGMA journal_mode = WAL");
			this.database.exec("PRAGMA synchronous = NORMAL");
			this.database.exec("PRAGMA busy_timeout = 5000");
			this.migrate();
		} catch (error) {
			this.database.close();
			throw error;
		}
	}

	prepare(sql: string): StatementSync {
		return this.database.prepare(sql);
	}

	exec(sql: string): void {
		this.database.exec(sql);
	}

	transaction<T>(operation: () => T): T {
		this.database.exec("BEGIN IMMEDIATE");
		try {
			const result = operation();
			this.database.exec("COMMIT");
			return result;
		} catch (error) {
			try {
				this.database.exec("ROLLBACK");
			} catch (rollbackError) {
				throw new WorkbenchError("storage_failure", "SQLite transaction and rollback both failed", {
					cause: new AggregateError([error, rollbackError]),
				});
			}
			throw error;
		}
	}

	close(): void {
		if (this.closed) return;
		this.database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
		this.database.close();
		this.closed = true;
	}

	compact(): void {
		this.database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
		this.database.exec("VACUUM");
		this.database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
	}

	private migrate(): void {
		this.database.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        applied_at TEXT NOT NULL,
        checksum TEXT NOT NULL
      ) STRICT
    `);
		const applied = this.database
			.prepare("SELECT version, name, checksum FROM schema_migrations ORDER BY version")
			.all() as unknown as MigrationRow[];
		const migrations = loadMigrations();
		const newestKnown = migrations.at(-1)?.version ?? 0;
		const newer = applied.find((entry) => entry.version > newestKnown);
		if (newer)
			throw new WorkbenchError(
				"storage_failure",
				`Database migration ${newer.version} is newer than this Workbench`,
			);
		for (const entry of applied) {
			const expected = migrations.find((migration) => migration.version === entry.version);
			if (!expected || expected.name !== entry.name || expected.checksum !== entry.checksum) {
				throw new WorkbenchError("storage_failure", `Database migration ${entry.version} checksum does not match`);
			}
		}
		for (const migration of migrations.filter((entry) => !applied.some((row) => row.version === entry.version))) {
			this.transaction(() => {
				this.database.exec(migration.sql);
				this.database
					.prepare("INSERT INTO schema_migrations(version, name, applied_at, checksum) VALUES (?, ?, ?, ?)")
					.run(migration.version, migration.name, new Date().toISOString(), migration.checksum);
			});
		}
	}
}
