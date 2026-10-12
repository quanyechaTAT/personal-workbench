import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, test } from "vitest";
import { WorkbenchDatabase } from "../src/database.ts";
import { SqliteKnowledgeRepository } from "../src/knowledge-repository.ts";

test("migrates JSON vectors to sqlite-vec, isolates projects, replaces atomically and deletes derived vectors", async () => {
	const root = await mkdtemp(join(tmpdir(), "workbench-vector-upgrade-"));
	const path = join(root, "state.db");
	let database: WorkbenchDatabase | undefined;
	try {
		const legacy = new DatabaseSync(path);
		legacy.exec(
			"CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL UNIQUE,applied_at TEXT NOT NULL,checksum TEXT NOT NULL) STRICT",
		);
		const migrations = new URL("../src/migrations/", import.meta.url);
		for (const name of (await readdir(migrations))
			.filter((name) => name.endsWith(".sql") && Number(name.slice(0, 3)) <= 14)
			.sort()) {
			const sql = await readFile(new URL(name, migrations), "utf8");
			legacy.exec(sql);
			legacy
				.prepare("INSERT INTO schema_migrations VALUES(?,?,?,?)")
				.run(
					Number(name.slice(0, 3)),
					name.slice(0, -4),
					new Date().toISOString(),
					createHash("sha256").update(sql).digest("hex"),
				);
		}
		const now = new Date().toISOString();
		for (const id of ["one", "two"])
			legacy
				.prepare(
					"INSERT INTO projects(id,slug,name,description,status,workspace_path,project_file_path,memory_file_path,created_at,updated_at) VALUES (?,?,?,'','active',?,?,?, ?,?)",
				)
				.run(id, id, id, root, join(root, "PROJECT.md"), join(root, "MEMORY.md"), now, now);
		// Start from a genuine v014 file, then run every additive migration on reopen.
		legacy.prepare("INSERT INTO knowledge_files VALUES('one','old.md','old-hash','model',1,?)").run(now);
		legacy.prepare("INSERT INTO knowledge_chunks VALUES('one','old.md',0,'legacy passage','[1,0]')").run();
		legacy.close();
		database = new WorkbenchDatabase(path);
		const repository = new SqliteKnowledgeRepository(database);
		expect((await repository.search("one", "model", [1, 0], 5))[0]).toMatchObject({
			path: "old.md",
			text: "legacy passage",
			score: 1,
		});
		expect(database.prepare("SELECT vector_json,dimension FROM knowledge_chunks").get()).toMatchObject({
			vector_json: "[]",
			dimension: 2,
		});
		await repository.replaceFile(
			{
				projectId: "two",
				path: "private.md",
				contentHash: "two",
				modelFingerprint: "model",
				chunkCount: 1,
				indexedAt: now,
			},
			[{ projectId: "two", path: "private.md", ordinal: 0, text: "private", vector: [1, 0] }],
		);
		expect((await repository.search("one", "model", [1, 0], 5)).map((hit) => hit.path)).toEqual(["old.md"]);
		await expect(
			repository.replaceFile(
				{
					projectId: "one",
					path: "old.md",
					contentHash: "broken",
					modelFingerprint: "model",
					chunkCount: 1,
					indexedAt: now,
				},
				[{ projectId: "one", path: "old.md", ordinal: 0, text: "invalid", vector: Array<number>(8193).fill(1) }],
			),
		).rejects.toThrow("维度无效");
		expect((await repository.search("one", "model", [1, 0], 5))[0]?.text).toBe("legacy passage");
		await expect(repository.search("one", "model", [1, 0, 0], 5)).rejects.toThrow("维度与项目索引不同");
		await repository.replaceFile(
			{
				projectId: "one",
				path: "current.md",
				contentHash: "current",
				modelFingerprint: "model",
				chunkCount: 1,
				indexedAt: now,
			},
			[{ projectId: "one", path: "current.md", ordinal: 0, text: "current passage", vector: [0.8, 0.2] }],
		);
		const document = {
			id: "old-document",
			projectId: "one",
			name: "old.md",
			path: "old.md",
			mimeType: "text/markdown",
			size: 1,
			sha256: "old-hash",
			status: "ready" as const,
			stage: "ready" as const,
			chunkCount: 1,
			processedChunks: 1,
			createdAt: now,
			updatedAt: now,
			diagnostics: [],
		};
		for (const state of [
			{ ...document, supersededBy: "new-document" },
			{ ...document, processingState: "stale" as const },
			{ ...document, status: "failed" as const, stage: "failed" as const },
		]) {
			await repository.saveDocument(state);
			expect((await repository.search("one", "model", [1, 0], 1)).map((hit) => hit.path)).toEqual(["current.md"]);
		}
		await repository.deleteFile("one", "current.md");
		await repository.deleteFile("one", "old.md");
		expect(await repository.search("one", "model", [1, 0], 5)).toEqual([]);
		expect(
			database.prepare("SELECT COUNT(*) AS count FROM knowledge_vec_2 WHERE project_id = 'one'").get()?.count,
		).toBe(0);
		database.compact();
		expect((await repository.search("two", "model", [1, 0], 5))[0]?.text).toBe("private");
	} finally {
		database?.close();
		await rm(root, { recursive: true, force: true });
	}
});
