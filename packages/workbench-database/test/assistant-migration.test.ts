import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { AgentProfileService, CapabilityService } from "@earendil-works/workbench-core";
import { expect, test } from "vitest";
import { WorkbenchDatabase } from "../src/database.ts";
import { createWorkbenchRepositories } from "../src/repositories.ts";

test("upgrades the original database, preserves session references and diagnoses ambiguous legacy Skills", async () => {
	const root = await mkdtemp(join(tmpdir(), "workbench-migration 中文 "));
	const path = join(root, "old.db");
	const now = new Date().toISOString();
	const sql = await readFile(new URL("../src/migrations/001_initial.sql", import.meta.url), "utf8");
	const old = new DatabaseSync(path);
	old.exec(sql);
	old.exec("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, name TEXT, applied_at TEXT, checksum TEXT)");
	old.prepare("INSERT INTO schema_migrations VALUES(1, '001_initial', ?, ?)").run(
		now,
		createHash("sha256").update(sql).digest("hex"),
	);
	old.prepare(
		"INSERT INTO projects VALUES('project', 'cv-learning', 'CV Learning', '', 'active', ?, ?, ?, ?, ?, NULL)",
	).run(join(root, "project"), join(root, "project", "PROJECT.md"), join(root, "project", "MEMORY.md"), now, now);
	old.prepare(
		"INSERT INTO agent_profiles VALUES('profile', 'custom', 'Original assistant', '', 'Original instructions', NULL, '[]', ?, 0, ?, ?)",
	).run(JSON.stringify(["ambiguous", "unique"]), now, now);
	for (const [id, slug, scope, projectId] of [
		["global", "ambiguous", "global", null],
		["project-skill", "ambiguous", "project", "project"],
		["unique", "unique", "global", null],
	]) {
		old.prepare("INSERT INTO skills VALUES(?, ?, ?, '', ?, ?, 1, ?, 'hash', 0, ?, ?)").run(
			id,
			slug,
			slug,
			scope,
			projectId,
			join(root, String(id), "SKILL.md"),
			now,
			now,
		);
	}
	old.prepare(
		"INSERT INTO sessions VALUES('session', 'pi', 'pi-session', 'same-history.jsonl', 'project', 'profile', 'Original conversation', 'project', 'idle', ?, NULL, ?, ?, ?, NULL, NULL)",
	).run(join(root, "project"), now, now, now);
	old.close();
	let database: WorkbenchDatabase | undefined;
	try {
		database = new WorkbenchDatabase(path);
		const repositories = createWorkbenchRepositories(database);
		const profiles = new AgentProfileService(repositories.profiles, repositories.skills, repositories.mcpConnections);
		await profiles.ensureBuiltins();
		const profile = await profiles.get("profile");
		expect(profile.skillIds).toEqual(["unique"]);
		expect(profile.bindingDiagnostics?.[0]).toContain("2 matches");
		expect(
			(await new CapabilityService(repositories.skills, repositories.mcpConnections).validateBindings(profile))[0]
				.code,
		).toBe("legacy_skill_binding");
		expect(await repositories.sessions.get("session")).toMatchObject({
			runtimeSessionId: "pi-session",
			runtimeRef: "same-history.jsonl",
			agentProfileId: "profile",
		});
		database.close();
		database = new WorkbenchDatabase(path);
		const reopened = createWorkbenchRepositories(database);
		expect((await reopened.profiles.get("profile"))?.bindingDiagnostics).toEqual(profile.bindingDiagnostics);
		const service = new AgentProfileService(reopened.profiles, reopened.skills, reopened.mcpConnections);
		const fixed = await service.update(profile.id, { ...profile, skillIds: ["global"] }, profile.version);
		expect(fixed.bindingDiagnostics).toEqual([]);
		database.prepare("UPDATE schema_migrations SET checksum = 'changed' WHERE version = 2").run();
		database.close();
		database = undefined;
		expect(() => new WorkbenchDatabase(path)).toThrow("checksum");
	} finally {
		database?.close();
		await rm(root, { recursive: true, force: true });
	}
});

test("migration 013 upgrades a version 012 session without changing its Pi history and persists thinking choices", async () => {
	const root = await mkdtemp(join(tmpdir(), "workbench-thinking-migration-"));
	const path = join(root, "upgrade.db");
	let database: WorkbenchDatabase | undefined;
	try {
		database = new WorkbenchDatabase(path);
		const original = createWorkbenchRepositories(database);
		await new AgentProfileService(original.profiles, original.skills, original.mcpConnections).ensureBuiltins();
		const profile = (await original.profiles.list())[0];
		const now = new Date().toISOString();
		await original.sessions.create({
			id: "durable",
			runtime: "pi",
			runtimeSessionId: "original-pi-id",
			runtimeRef: "original-history.jsonl",
			agentProfileId: profile.id,
			title: "升级前会话",
			kind: "personal",
			status: "idle",
			cwd: root,
			createdAt: now,
			updatedAt: now,
			lastActiveAt: now,
		});
		// Reconstruct the previous schema with the actual original migration checksums intact.
		database.exec(
			"ALTER TABLE sessions DROP COLUMN thinking_level; DELETE FROM schema_migrations WHERE version = 13",
		);
		database.close();
		database = new WorkbenchDatabase(path);
		const upgraded = createWorkbenchRepositories(database);
		const session = await upgraded.sessions.get("durable");
		expect(session).toMatchObject({
			runtimeSessionId: "original-pi-id",
			runtimeRef: "original-history.jsonl",
			title: "升级前会话",
		});
		expect(session?.thinkingLevel).toBeUndefined();
		if (!session) throw new Error("Missing upgraded session");
		await upgraded.sessions.update({ ...session, thinkingLevel: "max" });
		database.close();
		database = new WorkbenchDatabase(path);
		expect((await createWorkbenchRepositories(database).sessions.get("durable"))?.thinkingLevel).toBe("max");
		expect(database.prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 13").get()?.count).toBe(
			1,
		);
	} finally {
		database?.close();
		await rm(root, { recursive: true, force: true });
	}
});
