import { createHash } from "node:crypto";
import { copyFile, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { load } from "sqlite-vec";
import { expect, test } from "vitest";
import { WorkbenchDatabase } from "../src/database.ts";

test("v028 adds confidence and original verification dates without treating an upgrade as new evidence", async () => {
	const root = await mkdtemp(join(tmpdir(), "记忆元数据升级 "));
	const path = join(root, "memory.db");
	let database = new WorkbenchDatabase(path);
	try {
		const timestamp = "2025-01-02T03:04:05.000Z";
		for (const [id, confirmation] of [
			["user-fact", "user_confirmed"],
			["model-fact", "verified"],
			["unknown-fact", "unknown"],
		] as const) {
			const legacy = JSON.stringify({
				id,
				confirmation,
				validFrom: timestamp,
				updatedAt: timestamp,
				externalHash: "legacy-fingerprint",
				text: "保留原文",
				version: 1,
			});
			database
				.prepare(
					"INSERT INTO semantic_memories VALUES (?,NULL,'global','MEMORY.md','保留原文',1,'active',?,?,NULL,?)",
				)
				.run(id, confirmation, timestamp, legacy);
			database.prepare("INSERT INTO semantic_versions VALUES (?,1,?)").run(id, legacy);
		}
		// v028 only changes JSON data, so replay the migration against pre-upgrade records.
		database.prepare("DELETE FROM schema_migrations WHERE version=28").run();
		database.close();
		database = new WorkbenchDatabase(path);
		for (const [id, confidence] of [
			["user-fact", 1],
			["model-fact", 0.85],
			["unknown-fact", 0.4],
		] as const)
			for (const table of ["semantic_memories", "semantic_versions"]) {
				const row = database.prepare(`SELECT data_json FROM ${table} WHERE id=?`).get(id);
				const record: unknown = JSON.parse(String(row?.data_json));
				expect(record).toMatchObject({
					confidence,
					createdAt: timestamp,
					lastVerifiedAt: timestamp,
					updatedAt: timestamp,
					text: "保留原文",
				});
				expect(record).not.toHaveProperty("externalHash");
			}
	} finally {
		database.close();
		await rm(root, { recursive: true, force: true });
	}
});

test.each([{ defaultMode: undefined }, { defaultMode: "off" }, { defaultMode: "auto" }])(
	"upgrades v018 through v028, resets legacy $defaultMode policy and preserves managed documents",
	async ({ defaultMode }) => {
		const root = await mkdtemp(join(tmpdir(), "四层迁移 中文 空格 "));
		const original = join(root, "旧数据库.db"),
			upgraded = join(root, "升级副本.db");
		let database: WorkbenchDatabase | undefined;
		try {
			const old = new DatabaseSync(original, { allowExtension: true });
			try {
				load(old);
				old.enableLoadExtension(false);
				old.exec(
					"PRAGMA foreign_keys=ON; CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, applied_at TEXT NOT NULL, checksum TEXT NOT NULL) STRICT",
				);
				const directory = new URL("../src/migrations/", import.meta.url);
				for (const name of (await readdir(directory))
					.filter((name) => name.endsWith(".sql") && Number(name.slice(0, 3)) <= 18)
					.sort()) {
					const sql = await readFile(new URL(name, directory), "utf8");
					old.exec(sql);
					old.prepare("INSERT INTO schema_migrations VALUES(?,?,?,?)").run(
						Number(name.slice(0, 3)),
						name.slice(0, -4),
						"2026-01-01T00:00:00.000Z",
						createHash("sha256").update(sql).digest("hex"),
					);
				}
				old.prepare(
					"INSERT INTO projects(id,slug,name,description,status,workspace_path,project_file_path,memory_file_path,created_at,updated_at) VALUES('旧项目','legacy','旧项目','','active',?,?,?,'2026-01-01','2026-01-01')",
				).run(root, join(root, "PROJECT.md"), join(root, "MEMORY.md"));
				old.prepare(
					"INSERT INTO projects(id,slug,name,description,status,workspace_path,project_file_path,memory_file_path,created_at,updated_at) VALUES('策略项目','policy','策略项目','','active',?,?,?,'2026-01-01','2026-01-01')",
				).run(root, join(root, "PROJECT.md"), join(root, "MEMORY.md"));
				old.prepare("INSERT INTO settings VALUES('learning.project.策略项目',?,2,'2026-01-01')").run('"review"');
				if (defaultMode)
					old.prepare("INSERT INTO settings VALUES('learning.defaultMode',?,1,'2026-01-01')").run(
						JSON.stringify(defaultMode),
					);
				old.exec(
					"INSERT INTO settings VALUES('legacy.setting','{\"保留\":true}',1,'2026-01-01'); INSERT INTO memory_candidates(id,kind,project_id,relative_path,proposed_text,reason,preview,base_hash,status,created_at,updated_at) VALUES('legacy-candidate','project','旧项目','projects/legacy/MEMORY.md','原有事实','待审核','原文','original-hash','pending','2026-01-01','2026-01-01')",
				);
			} finally {
				old.close();
			}
			const originalBytes = await readFile(original);
			await copyFile(original, upgraded);
			database = new WorkbenchDatabase(upgraded);
			expect(database.prepare("SELECT name,memory_file_path FROM projects WHERE id='旧项目'").get()).toMatchObject({
				name: "旧项目",
				memory_file_path: join(root, "AGENTS.md"),
			});
			expect(
				database
					.prepare("SELECT status,proposed_text,base_hash FROM memory_candidates WHERE id='legacy-candidate'")
					.get(),
			).toMatchObject({ status: "pending", proposed_text: "原有事实", base_hash: "original-hash" });
			expect(database.prepare("SELECT value_json FROM settings WHERE key='legacy.setting'").get()?.value_json).toBe(
				'{"保留":true}',
			);
			expect(database.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get()?.count).toBe(28);
			expect(
				database.prepare("SELECT value_json FROM settings WHERE key='learning.project.旧项目'").get()?.value_json,
			).toBeUndefined();
			expect(
				database.prepare("SELECT value_json,version FROM settings WHERE key='learning.project.策略项目'").get(),
			).toBeUndefined();
			expect(
				database.prepare("SELECT value_json FROM settings WHERE key='learning.historyResetPending'").get()
					?.value_json,
			).toBe("true");
			for (const table of [
				"working_checkpoints",
				"episodic_memories",
				"semantic_memories",
				"knowledge_representations",
				"episodic_vectors",
				"learning_skill_state",
				"learning_skill_uses",
				"learning_snapshots",
				"learning_cadence",
				"learning_counted_runs",
				"project_deletions",
			])
				expect(database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()?.count).toBe(0);
			database.close();
			database = new WorkbenchDatabase(upgraded);
			expect(database.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get()?.count).toBe(28);
			expect(await readFile(original)).toEqual(originalBytes);
		} finally {
			database?.close();
			await rm(root, { recursive: true, force: true });
		}
	},
);
