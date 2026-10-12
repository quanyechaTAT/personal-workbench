import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { PathPolicy, WorkbenchPaths, WorkspaceManager, withoutProjectContext } from "@earendil-works/workbench-core";
import { expect, test } from "vitest";
import { createWorkbenchApplication } from "../src/application.ts";
import { createAssistantFixture } from "./assistant-fixture.ts";

test("one project AGENTS document feeds Gateway, reviewed facts and real Pi context without duplicate or superseded facts", async () => {
	const fixture = await createAssistantFixture();
	try {
		const paths = fixture.application.paths;
		expect((await readdir(paths.workspace)).filter((path) => path.endsWith(".md")).sort()).toEqual(["MEMORY.md"]);
		expect(await stat(paths.userMemory)).toBeDefined();
		const project = await fixture.application.createProject({
			name: "单一资料 中文 空格",
			description: "PROJECT_CONTEXT_SENTINEL",
		});
		expect(project.projectFilePath).toBe(project.memoryFilePath);
		expect((await readdir(project.workspacePath)).filter((path) => path.endsWith(".md"))).toEqual(["AGENTS.md"]);
		for (const text of ["项目使用 Python 3.10。", "项目使用 Python 3.12。"]) {
			const candidate = await fixture.application.services.memory.propose(
				{ project },
				{ kind: "project", proposedText: text, reason: "用户确认" },
			);
			expect(candidate.relativePath).toBe(`projects/${project.slug}/AGENTS.md`);
			await fixture.application.services.memory.accept(candidate.id);
		}
		const session = await fixture.application.createSession({ projectId: project.id });
		fixture.faux.setResponses([
			(context) => {
				expect(context.systemPrompt?.match(/PROJECT_CONTEXT_SENTINEL/gu)).toHaveLength(1);
				expect(context.systemPrompt?.match(/项目使用 Python 3\.12/gu)).toHaveLength(1);
				expect(context.systemPrompt).not.toContain("Python 3.10");
				return fauxAssistantMessage("使用统一项目资料继续。");
			},
		]);
		for await (const _event of fixture.application.events.subscribe(
			fixture.application.events.start(session.id, { text: "Python 项目版本" }).runId,
		)) {
			/* real Pi */
		}
		const path = `projects/${project.slug}/AGENTS.md`;
		const file = await fixture.application.services.files.read(path);
		const edited = await fixture.request("/files/write", {
			method: "PUT",
			body: JSON.stringify({
				path,
				expectedHash: file.contentHash,
				content: file.content.replace("PROJECT_CONTEXT_SENTINEL", "UPDATED_PROJECT_CONTEXT"),
			}),
		});
		expect(edited.status).toBe(200);
		for (const alias of [
			"AGENTS.md",
			"IDENTITY.md",
			`projects/${project.slug}/MEMORY.md`,
			`projects/${project.slug}/PROJECT.md`,
		])
			expect(
				(
					await fixture.request("/files/write", {
						method: "PUT",
						body: JSON.stringify({ path: alias, expectedHash: "outdated", content: "create duplicate" }),
					})
				).status,
			).toBe(400);
		await fixture.restart();
		expect((await fixture.application.services.projects.get(project.id)).memoryFilePath).toBe(project.memoryFilePath);
		expect(await fixture.application.services.files.read(path)).toMatchObject({
			content: expect.stringContaining("UPDATED_PROJECT_CONTEXT"),
		});
	} finally {
		await fixture.close();
	}
});

test("v022 project and global aliases consolidate with original backups, stable IDs, pending conflicts and repeatable recovery", async () => {
	const fixture = await createAssistantFixture();
	try {
		const paths = fixture.application.paths;
		const project = await fixture.application.createProject({ name: "升级旧资料" });
		const memory = fixture.application.services.memory;
		const previous = await memory.propose(
			{ project },
			{ kind: "project", proposedText: "项目使用 Python 3.10。", reason: "历史版本" },
		);
		await memory.accept(previous.id);
		const accepted = await memory.propose(
			{ project },
			{ kind: "project", proposedText: "项目使用 Python 3.12。", reason: "已确认事实" },
		);
		await memory.accept(accepted.id);
		const pending = await memory.propose(
			{ project },
			{ kind: "project", proposedText: "待审核旧候选", reason: "保留预览" },
		);
		const oldMemory = withoutProjectContext(await readFile(project.memoryFilePath, "utf8")).trim();
		const oldProject = "# 旧项目\r\n\r\n## Goal\r\nLEGACY_GOAL\r\n项目使用 Python 3.10。\r\n";
		const oldInstructions = "# 旧项目指令\r\nLOCAL_PROJECT_RULE\r\n项目使用 Python 3.12。\r\n";
		const oldGlobal = "# Workbench Instructions\r\n\r\nGLOBAL_CORRECTION\r\n";
		const oldIdentity = "# Personal Agent Identity\n\n使用中文交流。\n";
		for (const [path, content] of [
			[join(project.workspacePath, "PROJECT.md"), oldProject],
			[join(project.workspacePath, "MEMORY.md"), oldMemory],
			[project.memoryFilePath, oldInstructions],
			[join(paths.workspace, "AGENTS.md"), oldGlobal],
			[join(paths.workspace, "IDENTITY.md"), oldIdentity],
		])
			await writeFile(path, content);
		const oldPath = `projects/${project.slug}/MEMORY.md`;
		const legacyDatabase = new DatabaseSync(paths.database);
		legacyDatabase
			.prepare(
				"UPDATE semantic_memories SET relative_path=?,data_json=json_set(data_json,'$.relativePath',?) WHERE project_id=?",
			)
			.run(oldPath, oldPath, project.id);
		legacyDatabase
			.prepare("UPDATE semantic_versions SET data_json=json_set(data_json,'$.relativePath',?) WHERE id=?")
			.run(oldPath, accepted.id);
		legacyDatabase.prepare("UPDATE memory_candidates SET relative_path=? WHERE id=?").run(oldPath, pending.id);
		legacyDatabase
			.prepare("UPDATE projects SET project_file_path=?,memory_file_path=? WHERE id=?")
			.run(join(project.workspacePath, "PROJECT.md"), join(project.workspacePath, "MEMORY.md"), project.id);
		legacyDatabase.prepare("DELETE FROM schema_migrations WHERE version=23").run();
		legacyDatabase.close();
		await fixture.restart();
		const canonical = await readFile(project.memoryFilePath, "utf8");
		expect(canonical).toContain("LOCAL_PROJECT_RULE");
		expect(canonical).toContain("LEGACY_GOAL");
		expect(canonical.match(/项目使用 Python 3\.12/gu)).toHaveLength(2);
		expect(
			(await fixture.application.services.semantic.list({ project })).find((value) => value.id === accepted.id),
		).toMatchObject({
			version: 1,
			confirmation: "user_confirmed",
			relativePath: `projects/${project.slug}/AGENTS.md`,
		});
		expect((await fixture.application.services.semantic.history(accepted.id, { project }))[0]?.version).toBe(1);
		expect((await fixture.application.services.memory.getCandidate(pending.id)).status).toBe("conflicted");
		for (const [source, content] of [
			["AGENTS.md", oldGlobal],
			["IDENTITY.md", oldIdentity],
			[`projects/${project.slug}/PROJECT.md`, oldProject],
			[oldPath, oldMemory],
		]) {
			await expect(stat(join(paths.workspace, source))).rejects.toMatchObject({ code: "ENOENT" });
			const digest = createHash("sha256").update(content).digest("hex");
			expect(
				await readFile(join(paths.workspace, `memory/history/workspace-v1/${source}.${digest}.md`), "utf8"),
			).toBe(content);
		}
		expect(await readFile(join(paths.workspace, "MEMORY.md"), "utf8")).toContain("GLOBAL_CORRECTION");
		expect(await readFile(paths.userMemory, "utf8")).toContain("使用中文交流");
		const continued = await fixture.application.createSession({ projectId: project.id });
		fixture.faux.setResponses([
			(context) => {
				expect(context.systemPrompt).toContain("LOCAL_PROJECT_RULE");
				expect(context.systemPrompt).toContain("LEGACY_GOAL");
				expect(context.systemPrompt).not.toContain("项目使用 Python 3.10");
				expect(context.systemPrompt?.match(/项目使用 Python 3\.12/gu)).toHaveLength(1);
				return fauxAssistantMessage("使用当前版本继续。");
			},
		]);
		for await (const _event of fixture.application.events.subscribe(
			fixture.application.events.start(continued.id, { text: "核对 Python 版本" }).runId,
		)) {
			/* real Pi */
		}
		// Recreate a source as if the process stopped after publishing the canonical file, before retiring it.
		await writeFile(join(project.workspacePath, "MEMORY.md"), oldMemory);
		await fixture.restart();
		expect(await readFile(project.memoryFilePath, "utf8")).toBe(canonical);
		const changed = await fixture.application.services.memory.propose(
			{ project },
			{ kind: "project", proposedText: "项目使用 Python 3.13。", reason: "迁移后更新" },
		);
		await fixture.application.services.memory.accept(changed.id);
		await fixture.application.services.semantic.change(
			{ project },
			{
				kind: "project",
				proposedText: "恢复旧版",
				reason: "迁移后回滚",
				semanticChange: { operation: "rollback", targetId: accepted.id, expectedVersion: 2, rollbackVersion: 1 },
			},
		);
		expect(
			(await fixture.application.services.memory.search({ project }, "Python"))
				.map((value) => value.snippet)
				.join("\n"),
		).toContain("Python 3.12");
	} finally {
		await fixture.close();
	}
});

test("a second application cannot consolidate another live workspace", async () => {
	const fixture = await createAssistantFixture();
	try {
		const path = join(fixture.application.paths.workspace, "AGENTS.md");
		await writeFile(path, "RUNNING_USER_CONTENT");
		await expect(
			createWorkbenchApplication({
				dataRoot: fixture.application.paths.root,
				agentDir: join(fixture.root, "pi-agent"),
				embeddingEnvFile: fixture.embeddingEnvFile,
				pi: { modelRuntime: fixture.modelRuntime, defaultModel: fixture.model },
			}),
		).rejects.toThrow();
		expect(await readFile(path, "utf8")).toBe("RUNNING_USER_CONTENT");
	} finally {
		await fixture.close();
	}
});

test("filesystem consolidation refuses backup corruption and outside junctions without overwriting the original", async () => {
	const root = await mkdtemp(join(tmpdir(), "workspace-consolidation guard 中文 "));
	try {
		const paths = new WorkbenchPaths(join(root, "data"));
		const manager = new WorkspaceManager(paths);
		await manager.initialize();
		const policy = new PathPolicy(paths);
		const source = "# Workbench Instructions\n保留这份用户内容\n";
		await writeFile(join(paths.workspace, "AGENTS.md"), source);
		const targetBefore = await readFile(join(paths.workspace, "MEMORY.md"), "utf8");
		const digest = createHash("sha256").update(source).digest("hex");
		const archive = join(paths.memory, "history/workspace-v1");
		await mkdir(archive, { recursive: true });
		await writeFile(join(archive, `AGENTS.md.${digest}.md`), "corrupted backup");
		await expect(manager.consolidateLegacyMemory(policy, [])).rejects.toMatchObject({ code: "conflict" });
		expect(await readFile(join(paths.workspace, "AGENTS.md"), "utf8")).toBe(source);
		expect(await readFile(join(paths.workspace, "MEMORY.md"), "utf8")).toBe(targetBefore);
		const outside = join(root, "outside");
		await mkdir(outside);
		await writeFile(join(outside, "secret.md"), "OUTSIDE_PRIVATE");
		await symlink(outside, join(paths.workspace, "IDENTITY.md"), process.platform === "win32" ? "junction" : "dir");
		await expect(policy.requireWorkspace("IDENTITY.md/secret.md")).rejects.toMatchObject({ code: "path_denied" });
	} finally {
		expect(dirname(root)).toBe(tmpdir());
		await rm(root, { recursive: true, force: true });
	}
});
