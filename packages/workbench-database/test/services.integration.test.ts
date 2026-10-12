import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import {
	ArtifactService,
	MemoryService,
	PathPolicy,
	PermissionService,
	ProjectService,
	SettingsService,
	type SkillCatalogReader,
	SkillService,
	type SystemServices,
	TaskService,
	WorkbenchPaths,
	WorkspaceManager,
} from "@earendil-works/workbench-core";
import { afterEach, describe, expect, it } from "vitest";
import { WorkbenchDatabase } from "../src/database.ts";
import { createWorkbenchRepositories } from "../src/repositories.ts";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
	while (cleanups.length > 0) await cleanups.pop()?.();
});

function deterministicSystem(): SystemServices {
	let sequence = 0;
	return {
		id: () => `test-${++sequence}`,
		now: () => new Date("2026-09-15T08:00:00.000Z"),
	};
}

describe("Workbench core with SQLite", () => {
	it("persists projects, tasks, memory, artifacts, skills, settings, and approvals across restart", async () => {
		const container = await mkdtemp(join(tmpdir(), "Personal Workbench 集成测试 "));
		cleanups.push(async () => rm(container, { recursive: true, force: true }));
		const dataRoot = join(container, "data root");
		const paths = new WorkbenchPaths(dataRoot);
		const workspace = new WorkspaceManager(paths);
		await workspace.initialize();
		const originalUserMemory = await readFile(paths.userMemory, "utf8");
		await workspace.initialize();
		expect(await readFile(paths.userMemory, "utf8")).toBe(originalUserMemory);

		let database = new WorkbenchDatabase(paths.database);
		let repositories = createWorkbenchRepositories(database);
		const system = deterministicSystem();
		const policy = new PathPolicy(paths, [join(container, "credentials")]);
		const projects = new ProjectService(repositories.projects, workspace, system);
		const project = await projects.create({ name: "CV Learning", description: "Learn computer vision" });
		expect(project.slug).toBe("cv-learning");
		expect(await readFile(project.projectFilePath, "utf8")).toContain("Learn computer vision");

		const tasks = new TaskService(repositories.tasks, system);
		const parent = await tasks.create({
			projectId: project.id,
			title: "Prepare dataset",
			type: "agent",
			priority: 4,
		});
		const child = await tasks.create({
			projectId: project.id,
			parentId: parent.id,
			title: "Collect samples",
			status: "backlog",
		});
		const updatedTask = await tasks.update(child.id, { status: "running", expectedVersion: child.version });
		expect(updatedTask.version).toBe(2);
		await expect(tasks.update(child.id, { status: "done", expectedVersion: child.version })).rejects.toMatchObject({
			code: "conflict",
		});

		const memory = new MemoryService(paths, policy, repositories.memory, system);
		await memory.reindex("user", "USER.md");
		await memory.reindex("global", "MEMORY.md");
		await memory.reindex(
			"project",
			relative(paths.workspace, project.memoryFilePath).replaceAll("\\", "/"),
			project.id,
		);
		const candidate = await memory.propose(
			{ project },
			{
				kind: "project",
				heading: "模型选择",
				proposedText: "使用视觉 Transformer 作为基线模型。",
				reason: "记录项目的稳定技术决策",
				idempotencyKey: "memory-proposal-1",
			},
		);
		expect(
			(
				await memory.propose(
					{ project },
					{
						kind: "project",
						proposedText: "ignored duplicate",
						reason: "duplicate",
						idempotencyKey: "memory-proposal-1",
					},
				)
			).id,
		).toBe(candidate.id);
		const accepted = await memory.accept(candidate.id);
		expect(accepted.status).toBe("accepted");
		const chineseResults = await memory.search({ project }, "视觉", 5);
		expect(chineseResults[0]).toMatchObject({ kind: "project", projectId: project.id });
		expect(chineseResults[0].snippet).toContain("视觉 Transformer");

		const conflicting = await memory.propose(
			{ project },
			{ kind: "project", proposedText: "新的决策", reason: "test conflict" },
		);
		await writeFile(
			project.memoryFilePath,
			`${await readFile(project.memoryFilePath, "utf8")}External edit\n`,
			"utf8",
		);
		expect((await memory.accept(conflicting.id)).status).toBe("conflicted");

		const artifactPath = join(paths.project(project.slug).artifactsDir, "summary.md");
		await writeFile(artifactPath, "# Training summary\n", "utf8");
		const artifacts = new ArtifactService(paths, policy, repositories.artifacts, system);
		const artifact = await artifacts.register({
			projectId: project.id,
			type: "report",
			name: "Training summary",
			workspaceRelativePath: relative(paths.workspace, artifactPath),
			idempotencyKey: "artifact-1",
		});
		expect(artifact.mimeType).toBe("text/markdown");
		expect(
			(
				await artifacts.register({
					projectId: project.id,
					type: "report",
					name: "Duplicate",
					workspaceRelativePath: relative(paths.workspace, artifactPath),
					idempotencyKey: "artifact-1",
				})
			).id,
		).toBe(artifact.id);

		const skillRoot = join(paths.skills, "research");
		await mkdir(skillRoot, { recursive: true });
		await writeFile(
			join(skillRoot, "SKILL.md"),
			"---\nname: research\ndescription: Source-grounded research\n---\nResearch carefully.\n",
		);
		const catalog: SkillCatalogReader = {
			readDirectory: (directory) => ({
				skills: [
					{
						name: "research",
						description: "Source-grounded research",
						filePath: join(directory, "research", "SKILL.md"),
						baseDir: join(directory, "research"),
						disableModelInvocation: false,
					},
				],
				diagnostics: [],
			}),
		};
		const skills = new SkillService(paths, repositories.skills, catalog, system);
		const [skill] = await skills.discover("global");
		expect(skill.name).toBe("research");
		expect((await skills.setEnabled(skill.id, false)).enabled).toBe(false);

		const settings = new SettingsService(repositories.settings, system);
		const savedSetting = await settings.set("agent.defaultMode", "general");
		expect(savedSetting.version).toBe(1);
		expect((await settings.set("agent.defaultMode", "coding", 1)).version).toBe(2);

		const permissions = new PermissionService(repositories.approvals, system);
		await permissions.initialize();
		const pending = await permissions.request({
			sessionId: "session-1",
			runId: "run-1",
			toolCallId: "tool-1",
			toolName: "powershell",
			operation: { command: "Get-ChildItem", cwd: project.workspacePath },
		});
		await permissions.resolve(pending.approval.id, "approved");
		expect(await pending.decision).toBe("approved");
		await permissions.dispose();

		expect((await policy.classify(paths.database)).zone).toBe("internal-state");
		await expect(policy.requireWorkspace("../outside.txt")).rejects.toMatchObject({ code: "path_denied" });
		await expect(policy.requireAgentWrite("projects/cv-learning/MEMORY.md")).rejects.toMatchObject({
			code: "path_denied",
		});
		const outside = join(container, "outside");
		await mkdir(outside);
		const junction = join(paths.workspace, "escape-link");
		await symlink(outside, junction, process.platform === "win32" ? "junction" : "dir");
		await expect(policy.requireWorkspace("escape-link/secret.txt")).rejects.toMatchObject({ code: "path_denied" });

		database.close();
		database = new WorkbenchDatabase(paths.database);
		repositories = createWorkbenchRepositories(database);
		expect((await repositories.projects.get(project.id))?.name).toBe("CV Learning");
		expect((await repositories.tasks.get(child.id))?.status).toBe("running");
		expect((await repositories.memory.getCandidate(candidate.id))?.status).toBe("accepted");
		expect((await repositories.artifacts.list(project.id))[0].sha256).toBe(artifact.sha256);
		expect((await repositories.settings.get("agent.defaultMode"))?.value).toBe("coding");
		expect((await repositories.skills.get(skill.id))?.enabled).toBe(false);
		expect((await repositories.approvals.get(pending.approval.id))?.status).toBe("approved");
		database.close();
	});

	it("refuses a database whose applied migration checksum was changed", async () => {
		const root = await mkdtemp(join(tmpdir(), "workbench-migration-"));
		cleanups.push(async () => rm(root, { recursive: true, force: true }));
		const path = join(root, "workbench.db");
		const database = new WorkbenchDatabase(path);
		database.prepare("UPDATE schema_migrations SET checksum = 'tampered' WHERE version = 1").run();
		database.close();
		expect(() => new WorkbenchDatabase(path)).toThrowError(/checksum/u);
	});
});
