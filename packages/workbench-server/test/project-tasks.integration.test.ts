import { mkdir, readFile, realpath, rename, stat, symlink, writeFile } from "node:fs/promises";
import { join, parse } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import type { Project, WorkbenchSession, WorkbenchTask } from "@earendil-works/workbench-core";
import { expect, test } from "vitest";
import { createAssistantFixture } from "./assistant-fixture.ts";

test("links an existing project without copying it and applies the selected assistant after restart", async () => {
	const fixture = await createAssistantFixture();
	try {
		const sourcePath = join(fixture.root, "已有项目 中文");
		await mkdir(sourcePath);
		await writeFile(join(sourcePath, "README.md"), "original project");
		await writeFile(join(sourcePath, "AGENTS.md"), "SOURCE_PROJECT_INSTRUCTION");
		const profile = await fixture.application.services.profiles.getBySlug("standard");
		const response = await fixture.request("/projects", {
			method: "POST",
			body: JSON.stringify({ sourcePath }),
		});
		expect(response.status).toBe(201);
		const project = (await response.json()) as Project;
		expect(project.name).toBe("已有项目 中文");
		expect(project.sourcePath).toBe(await realpath(sourcePath));
		expect(project.workspacePath).not.toBe(sourcePath);
		expect((await stat(project.memoryFilePath)).isFile()).toBe(true);
		await fixture.restart();
		const session = await fixture.application.createSession({ projectId: project.id, profileId: profile.id });
		expect(session.agentProfileId).toBe(profile.id);
		expect(session.cwd).toBe(project.sourcePath);
		fixture.faux.setResponses([
			(context) => {
				expect(context.systemPrompt).toContain("SOURCE_PROJECT_INSTRUCTION");
				expect(context.systemPrompt).toContain(project.workspacePath);
				return fauxAssistantMessage(
					fauxToolCall("write", { path: "result.txt", content: "selected assistant output" }),
					{ stopReason: "toolUse" },
				);
			},
			fauxAssistantMessage("完成"),
		]);
		const run = (await (
			await fixture.request(`/sessions/${session.id}/messages`, {
				method: "POST",
				body: JSON.stringify({ text: "在当前项目创建文件" }),
			})
		).json()) as { runId: string };
		const events = await (await fixture.request(`/runs/${run.runId}/events`)).text();
		expect(events).toContain("run.completed");
		expect(events).not.toContain("permission.requested");
		expect(await readFile(join(sourcePath, "result.txt"), "utf8")).toBe("selected assistant output");
		expect(await readFile(join(sourcePath, "README.md"), "utf8")).toBe("original project");
	} finally {
		await fixture.close();
	}
});

test("delegates a personal human task to the chosen assistant and cleans its completed execution history", async () => {
	const fixture = await createAssistantFixture();
	try {
		const profile = await fixture.application.services.profiles.create({
			name: "任务执行预设",
			systemPrompt: "CHOSEN_TASK_ASSISTANT",
			tools: ["task_list"],
		});
		const task = await fixture.application.services.tasks.create({ title: "个人任务", description: "检查今日任务" });
		fixture.faux.setResponses([
			(context) => {
				expect(context.systemPrompt).toContain("CHOSEN_TASK_ASSISTANT");
				return fauxAssistantMessage("任务完成，请确认");
			},
		]);
		const response = await fixture.request(`/tasks/${task.id}/run`, {
			method: "POST",
			body: JSON.stringify({ profileId: profile.id, expectedVersion: task.version }),
		});
		expect(response.status).toBe(202);
		const result = (await response.json()) as { session: WorkbenchSession; runId: string };
		expect(result.session.kind).toBe("background");
		expect(result.session.agentProfileId).toBe(profile.id);
		await (await fixture.request(`/runs/${result.runId}/events`)).text();
		const review = await fixture.application.services.tasks.get(task.id);
		expect(review).toMatchObject({ status: "review", type: "agent", assignedTo: profile.id });
		const done = await fixture.application.services.tasks.update(task.id, {
			status: "done",
			expectedVersion: review.version,
		});
		const preview = await fixture.request("/tasks/cleanup/preview", {
			method: "POST",
			body: JSON.stringify({ completedBefore: new Date(Date.now() + 1000).toISOString() }),
		});
		expect(preview.status).toBe(200);
		const previewData = (await preview.json()) as { tasks: WorkbenchTask[]; sessionCount: number };
		expect(previewData.tasks.map((item) => item.id)).toContain(task.id);
		expect(previewData.sessionCount).toBe(1);
		const clean = await fixture.request("/tasks/cleanup", {
			method: "POST",
			body: JSON.stringify({ tasks: [{ id: done.id, expectedVersion: done.version }], deleteHistory: true }),
		});
		expect(clean.status).toBe(200);
		expect(await clean.json()).toMatchObject({ deletedTasks: 1, deletedSessions: 1 });
		expect(await fixture.application.repositories.sessions.get(result.session.id)).toBeUndefined();
		await expect(stat(result.session.runtimeRef)).rejects.toMatchObject({ code: "ENOENT" });
		await fixture.restart();
		expect(await fixture.application.services.tasks.list()).toHaveLength(0);
		expect(await fixture.application.services.sessions.list()).toHaveLength(0);
	} finally {
		await fixture.close();
	}
});

test("rejects invalid project sources and unavailable assistant presets before creating data", async () => {
	const fixture = await createAssistantFixture();
	try {
		const file = join(fixture.root, "a-file.txt");
		await writeFile(file, "not a directory");
		for (const sourcePath of [
			"relative/path",
			file,
			join(fixture.root, "missing"),
			parse(fixture.root).root,
			fixture.application.paths.state,
			join(fixture.root, "pi-agent"),
			fixture.root,
		]) {
			const response = await fixture.request("/projects", {
				method: "POST",
				body: JSON.stringify({ sourcePath }),
			});
			expect([400, 403]).toContain(response.status);
		}
		const profile = await fixture.application.services.profiles.create({
			name: "Archived preset",
			systemPrompt: "archived",
		});
		await fixture.application.services.profiles.archive(profile.id, profile.version);
		expect(
			(
				await fixture.request("/projects", {
					method: "POST",
					body: JSON.stringify({ sourcePath: fixture.root, defaultProfileId: profile.id }),
				})
			).status,
		).toBe(400);
		expect(await fixture.application.services.projects.list()).toHaveLength(0);
	} finally {
		await fixture.close();
	}
});

test("project file access stays in the selected source and detects conflicts, traversal and Windows junctions", async () => {
	const fixture = await createAssistantFixture();
	try {
		const sourcePath = join(fixture.root, "source");
		const outside = join(fixture.root, "outside");
		await mkdir(sourcePath);
		await mkdir(outside);
		await writeFile(join(sourcePath, "README.md"), "source content");
		await writeFile(join(outside, "secret.txt"), "outside content");
		const project = await fixture.application.createProject({ name: "Linked files", sourcePath });
		expect(
			(
				await fixture.request("/projects", {
					method: "POST",
					body: JSON.stringify({ sourcePath }),
				})
			).status,
		).toBe(409);
		const prefix = `/projects/${project.id}/files`;
		const listing = await fixture.request(`${prefix}/list`);
		expect(await listing.json()).toContainEqual(expect.objectContaining({ name: "README.md", path: "README.md" }));
		const file = (await (await fixture.request(`${prefix}/read?path=README.md`)).json()) as {
			content: string;
			contentHash: string;
		};
		expect(file.content).toBe("source content");
		expect(
			(
				await fixture.request(`${prefix}/write`, {
					method: "PUT",
					body: JSON.stringify({ path: "README.md", content: "edited", expectedHash: file.contentHash }),
				})
			).status,
		).toBe(200);
		expect(
			(
				await fixture.request(`${prefix}/write`, {
					method: "PUT",
					body: JSON.stringify({ path: "README.md", content: "overwrite", expectedHash: file.contentHash }),
				})
			).status,
		).toBe(409);
		for (const path of ["../outside/secret.txt", join(outside, "secret.txt"), "../../pi-agent/auth.json"])
			expect((await fixture.request(`${prefix}/read?path=${encodeURIComponent(path)}`)).status).toBe(403);
		await symlink(outside, join(sourcePath, "escape"), process.platform === "win32" ? "junction" : "dir");
		expect((await fixture.request(`${prefix}/read?path=escape/secret.txt`)).status).toBe(403);
		expect(
			(await fixture.request(`/files/read?path=${encodeURIComponent(join(sourcePath, "README.md"))}`)).status,
		).toBe(403);
		await rename(sourcePath, `${sourcePath}-moved`);
		await expect(fixture.application.createSession({ projectId: project.id })).rejects.toMatchObject({
			code: "invalid_input",
		});
		expect(await readFile(project.memoryFilePath, "utf8")).toContain("项目经验");
	} finally {
		await fixture.close();
	}
});

test("task startup validates versions and prevents duplicate sessions or edits while a run is active", async () => {
	const fixture = await createAssistantFixture(undefined, { tokensPerSecond: 12 });
	try {
		const profile = await fixture.application.services.profiles.getBySlug("standard");
		const task = await fixture.application.services.tasks.create({ title: "Slow personal task" });
		expect(
			(
				await fixture.request(`/tasks/${task.id}/run`, {
					method: "POST",
					body: JSON.stringify({ profileId: profile.id, expectedVersion: 99 }),
				})
			).status,
		).toBe(409);
		expect(await fixture.application.services.sessions.list()).toHaveLength(0);
		fixture.faux.setResponses([
			fauxAssistantMessage("A deliberate task run that can be stopped while checking concurrency."),
		]);
		const responses = await Promise.all(
			[0, 1].map(() =>
				fixture.request(`/tasks/${task.id}/run`, {
					method: "POST",
					body: JSON.stringify({ profileId: profile.id, expectedVersion: task.version }),
				}),
			),
		);
		expect(responses.map((response) => response.status).sort()).toEqual([202, 409]);
		const result = (await responses.find((response) => response.status === 202)!.json()) as {
			session: WorkbenchSession;
			runId: string;
		};
		expect(await fixture.application.services.sessions.list()).toHaveLength(1);
		const running = await fixture.application.services.tasks.get(task.id);
		await expect(
			fixture.application.services.tasks.update(task.id, { status: "done", expectedVersion: running.version }),
		).rejects.toMatchObject({ code: "conflict" });
		expect(
			(
				await fixture.request("/tasks/cleanup", {
					method: "POST",
					body: JSON.stringify({
						tasks: [{ id: task.id, expectedVersion: running.version }],
						deleteHistory: true,
					}),
				})
			).status,
		).toBe(409);
		await fixture.request(`/sessions/${result.session.id}/abort`, { method: "POST" });
		await (await fixture.request(`/runs/${result.runId}/events`)).text();
		expect((await fixture.application.services.tasks.get(task.id)).status).toBe("cancelled");
	} finally {
		await fixture.close();
	}
});

async function completedTask(fixture: Awaited<ReturnType<typeof createAssistantFixture>>, projectId?: string) {
	const task = await fixture.application.services.tasks.create({ title: "Completed task", projectId });
	fixture.faux.setResponses([fauxAssistantMessage("completed for review")]);
	const result = await fixture.application.startTask(task.id);
	await (await fixture.request(`/runs/${result.runId}/events`)).text();
	const review = await fixture.application.services.tasks.get(task.id);
	expect(review.status).toBe("review");
	const done = await fixture.application.services.tasks.update(task.id, {
		status: "done",
		expectedVersion: review.version,
	});
	return { done, ...result };
}

test("cleanup keeps project files, accepted Memory, Artifacts and normal conversations", async () => {
	const fixture = await createAssistantFixture();
	try {
		const project = await fixture.application.createProject({ name: "Preserved project" });
		const normal = await fixture.application.createSession({ projectId: project.id, title: "Normal conversation" });
		const { done, taskRun, session } = await completedTask(fixture, project.id);
		const file = join(project.workspacePath, "artifacts", "report.txt");
		await writeFile(file, "preserved artifact");
		const artifact = await fixture.application.services.artifacts.register({
			name: "Report",
			type: "report",
			projectId: project.id,
			sessionId: session.id,
			taskRunId: taskRun.id,
			workspaceRelativePath: `projects/${project.slug}/artifacts/report.txt`,
		});
		const memory = await fixture.application.services.memory.propose(
			{ project },
			{ kind: "project", proposedText: "KEEP_THIS_MEMORY", reason: "confirmed", sessionId: session.id },
		);
		await fixture.application.services.memory.accept(memory.id);
		await fixture.application.services.taskCleanup.cleanup([{ id: done.id, expectedVersion: done.version }], true);
		expect(await readFile(file, "utf8")).toBe("preserved artifact");
		expect(await readFile(project.memoryFilePath, "utf8")).toContain("KEEP_THIS_MEMORY");
		expect((await fixture.application.services.artifacts.list())[0]).toMatchObject({
			id: artifact.id,
			sessionId: undefined,
			taskRunId: undefined,
		});
		expect(await fixture.application.repositories.sessions.get(normal.id)).toBeDefined();
		await fixture.restart();
		expect(await fixture.application.services.projects.list()).toHaveLength(1);
		expect(await fixture.application.services.sessions.list()).toHaveLength(1);
	} finally {
		await fixture.close();
	}
});

test("metadata-only cleanup retains the same Pi history and startup completes a journaled cleanup", async () => {
	const fixture = await createAssistantFixture();
	try {
		const first = await completedTask(fixture);
		expect(
			await fixture.application.services.taskCleanup.cleanup(
				[{ id: first.done.id, expectedVersion: first.done.version }],
				false,
			),
		).toMatchObject({ deletedTasks: 1, deletedSessions: 0 });
		expect(await fixture.application.services.sessions.readTranscript(first.session.id)).not.toHaveLength(0);
		const second = await completedTask(fixture);
		await fixture.application.services.tasks.requestCleanup(
			[{ id: second.done.id, expectedVersion: second.done.version }],
			true,
		);
		await fixture.restart();
		expect(await fixture.application.services.tasks.list()).toHaveLength(0);
		expect(await fixture.application.repositories.sessions.get(second.session.id)).toBeUndefined();
		await expect(stat(second.session.runtimeRef)).rejects.toMatchObject({ code: "ENOENT" });
		expect(await fixture.application.services.sessions.readTranscript(first.session.id)).not.toHaveLength(0);
	} finally {
		await fixture.close();
	}
});

test("cleanup validates the whole selection atomically and excludes parents of unfinished tasks", async () => {
	const fixture = await createAssistantFixture();
	try {
		const parent = await fixture.application.services.tasks.create({ title: "Completed parent", status: "done" });
		await fixture.application.services.tasks.create({ title: "Unfinished child", parentId: parent.id });
		const done = await fixture.application.services.tasks.create({ title: "Eligible", status: "done" });
		const before = new Date(Date.now() + 1000).toISOString();
		const preview = await fixture.application.services.taskCleanup.preview({ completedBefore: before });
		expect(preview.tasks.map((task) => task.id)).toEqual([done.id]);
		await expect(
			fixture.application.services.taskCleanup.cleanup(
				[
					{ id: done.id, expectedVersion: done.version },
					{ id: parent.id, expectedVersion: parent.version },
				],
				false,
			),
		).rejects.toMatchObject({ code: "conflict" });
		expect((await fixture.application.services.tasks.get(done.id)).cleanupRequestedAt).toBeUndefined();
		const edited = await fixture.application.services.tasks.update(done.id, {
			title: "Edited",
			expectedVersion: done.version,
		});
		await expect(
			fixture.application.services.taskCleanup.cleanup([{ id: done.id, expectedVersion: done.version }], false),
		).rejects.toMatchObject({ code: "conflict" });
		await fixture.application.services.tasks.requestCleanup(
			[{ id: edited.id, expectedVersion: edited.version }],
			false,
		);
		await expect(
			fixture.application.services.tasks.create({ title: "Child during cleanup", parentId: edited.id }),
		).rejects.toMatchObject({ code: "conflict" });
	} finally {
		await fixture.close();
	}
});
