import { createHash } from "node:crypto";
import { mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import type { KnowledgeDocument, Project, ProjectDeletionPreview } from "@earendil-works/workbench-core";
import { WorkbenchDatabase } from "@earendil-works/workbench-database";
import { expect, test, vi } from "vitest";
import { createAssistantFixture } from "./assistant-fixture.ts";
import { completeLearningTask, LEARNED_FACT } from "./project-learning-fixture.ts";

type Fixture = Awaited<ReturnType<typeof createAssistantFixture>>;
function database<T>(fixture: Fixture, operation: (db: WorkbenchDatabase) => T): T {
	const db = new WorkbenchDatabase(fixture.application.paths.database);
	try {
		return operation(db);
	} finally {
		db.close();
	}
}
async function preview(fixture: Fixture, project: Project): Promise<ProjectDeletionPreview> {
	const response = await fixture.request(`/projects/${project.id}/deletion-preview`);
	expect(response.status).toBe(200);
	return (await response.json()) as ProjectDeletionPreview;
}
async function remove(fixture: Fixture, project: Project, fingerprint?: string) {
	return fixture.request(`/projects/${project.id}`, {
		method: "DELETE",
		body: JSON.stringify({ expectedFingerprint: fingerprint ?? (await preview(fixture, project)).fingerprint }),
	});
}
async function linkedProject(fixture: Fixture) {
	const sourcePath = join(fixture.root, "源项目 中文 空格");
	await mkdir(sourcePath);
	await writeFile(join(sourcePath, "保留.txt"), "用户原有项目文件");
	return fixture.application.createProject({ sourcePath });
}

test("deleting a project cascades managed data, Pi history and vector indexes while preserving the source, other projects and USER.md", async () => {
	const fixture = await createAssistantFixture();
	try {
		const project = await linkedProject(fixture);
		const other = await fixture.application.createProject({ name: "其他项目" });
		const otherSession = await fixture.application.createSession({ projectId: other.id });
		const personal = await fixture.application.createSession({});
		const user = await fixture.application.services.memory.propose(
			{},
			{ kind: "user", proposedText: "用户偏好简短中文回答。", reason: "用户确认" },
		);
		await fixture.application.services.memory.accept(user.id);
		const userBefore = await readFile(fixture.application.paths.userMemory, "utf8");
		const learned = await completeLearningTask(fixture, project.id);
		await vi.waitFor(
			async () => {
				const reviews = await fixture.application.services.learning.list(project.id);
				expect(reviews[0]?.changes.map((change) => change.status)).toEqual(["applied", "applied"]);
				expect(await fixture.application.services.learning.isBusy(project.id)).toBe(false);
			},
			{ timeout: 15_000 },
		);
		await fixture.application.services.learning.configure(project.id, { memoryInterval: 0, skillInterval: 0 });
		const archived = await fixture.application.createSession({ projectId: project.id });
		await fixture.application.services.sessions.archive(archived.id, true);
		const task = await fixture.application.services.tasks.create({ projectId: project.id, title: "项目任务" });
		fixture.faux.setResponses([fauxAssistantMessage("任务完成。")]);
		const taskRun = await fixture.application.startTask(task.id);
		await (await fixture.request(`/runs/${taskRun.runId}/events`)).text();
		const externalChild = await fixture.application.services.tasks.create({
			projectId: other.id,
			title: "另一项目的任务",
		});
		const artifactPath = join(project.workspacePath, "artifacts", "成果.txt");
		await writeFile(artifactPath, "项目成果");
		await fixture.application.services.artifacts.register({
			projectId: project.id,
			sessionId: taskRun.session.id,
			taskRunId: taskRun.taskRun.id,
			name: "成果",
			type: "report",
			workspaceRelativePath: `projects/${project.slug}/artifacts/成果.txt`,
		});
		const attachmentResponse = await fixture.request(
			`/sessions/${learned.session.id}/attachments?name=${encodeURIComponent("对话附件.txt")}`,
			{
				method: "POST",
				headers: { "content-type": "application/octet-stream" },
				body: new Uint8Array(Buffer.from("对话附件")),
			},
		);
		expect(attachmentResponse.status).toBe(201);
		const documentResponse = await fixture.request(
			`/projects/${project.id}/knowledge/documents?name=${encodeURIComponent("资料.txt")}`,
			{
				method: "POST",
				headers: { "content-type": "application/octet-stream" },
				body: new Uint8Array(Buffer.from("项目资料内容")),
			},
		);
		expect(documentResponse.status).toBe(202);
		const document = (await documentResponse.json()) as KnowledgeDocument;
		await vi.waitFor(
			async () => expect(await fixture.application.services.knowledge.isBusy(project.id)).toBe(false),
			{ timeout: 15_000 },
		);
		await fixture.application.repositories.knowledge.replaceFile(
			{
				projectId: project.id,
				path: "删除测试向量.txt",
				contentHash: "fixture-hash",
				modelFingerprint: "fixture-space",
				chunkCount: 1,
				indexedAt: new Date().toISOString(),
			},
			[
				{
					projectId: project.id,
					path: "删除测试向量.txt",
					ordinal: 0,
					text: "DELETE_VECTOR_EVIDENCE",
					vector: [1, 0, 0],
				},
			],
		);
		await fixture.application.repositories.knowledge.replaceFile(
			{
				projectId: other.id,
				path: "保留向量.txt",
				contentHash: "other-hash",
				modelFingerprint: "fixture-space",
				chunkCount: 1,
				indexedAt: new Date().toISOString(),
			},
			[{ projectId: other.id, path: "保留向量.txt", ordinal: 0, text: "KEEP_VECTOR_EVIDENCE", vector: [0, 1, 0] }],
		);
		const facts = await fixture.application.services.semantic.list({ project });
		expect(facts.some((fact) => fact.text === LEARNED_FACT)).toBe(true);
		const skill = (await fixture.application.services.skills.list({ projectId: project.id })).find(
			(item) => item.slug === "learned-inspect-project",
		)!;
		const profile = await fixture.application.services.profiles.create({
			name: "保留助手",
			systemPrompt: "保留",
			skillIds: [skill.id],
		});
		const paths = fixture.application.paths;
		const projectFact = facts.find((fact) => fact.projectId === project.id)!;
		const history = join(paths.memory, "history", projectFact.id);
		const userHistory = join(paths.memory, "history", user.id);
		const fileHistory = join(
			paths.memory,
			"history",
			"files",
			createHash("sha256").update(`projects/${project.slug}/AGENTS.md`).digest("hex"),
		);
		const legacyHistory = join(paths.memory, "history", "workspace-v1", "projects", project.slug);
		for (const directory of [history, fileHistory, legacyHistory]) {
			await mkdir(directory, { recursive: true });
			await writeFile(join(directory, "旧版.md"), "项目历史");
		}
		database(fixture, (db) => {
			db.prepare("INSERT INTO approvals VALUES(?,?,?,?,?,?,?,?,?,?)").run(
				"delete-approval",
				learned.session.id,
				learned.runId,
				"tool",
				"shell",
				"{}",
				"approved",
				"2026-01-01",
				"2026-01-02",
				"2026-01-01",
			);
		});
		const confirmation = await preview(fixture, project);
		expect(confirmation.counts).toMatchObject({
			sessions: 3,
			tasks: 1,
			artifacts: 1,
			skills: 1,
			facts: 1,
			documents: 1,
			reviews: 1,
		});
		expect(confirmation.counts.episodes).toBeGreaterThan(0);
		const response = await remove(fixture, project, confirmation.fingerprint);
		expect(response.status, await response.clone().text()).toBe(200);
		expect(await response.json()).toMatchObject({ deleted: true, projectId: project.id, compacted: true });
		for (const path of [
			project.workspacePath,
			learned.session.runtimeRef,
			archived.runtimeRef,
			taskRun.session.runtimeRef,
			join(paths.inbox, "chat-attachments", learned.session.id),
			history,
			fileHistory,
			legacyHistory,
		])
			await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
		expect(await readFile(join(project.sourcePath!, "保留.txt"), "utf8")).toBe("用户原有项目文件");
		expect(await readFile(paths.userMemory, "utf8")).toBe(userBefore);
		expect(await stat(userHistory)).toBeDefined();
		expect(await fixture.application.services.semantic.history(user.id, {})).toHaveLength(1);
		expect((await fixture.application.services.tasks.get(externalChild.id)).parentId).toBeUndefined();
		expect((await fixture.application.services.profiles.get(profile.id)).skillIds).toEqual([]);
		database(fixture, (db) => {
			for (const table of [
				"sessions",
				"tasks",
				"memory_files",
				"memory_candidates",
				"semantic_memories",
				"episodic_memories",
				"working_checkpoints",
				"skills",
				"skill_imports",
				"artifacts",
				"activity",
				"knowledge_files",
				"knowledge_chunks",
				"knowledge_documents",
				"knowledge_representations",
				"project_learning_reviews",
				"learning_skill_state",
				"learning_skill_uses",
				"learning_snapshots",
				"learning_cadence",
				"project_deletions",
			])
				expect(
					db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE project_id=?`).get(project.id)?.count,
					table,
				).toBe(0);
			expect(db.prepare("SELECT COUNT(*) AS count FROM knowledge_vec_3").get()?.count).toBe(1);
			expect(
				db.prepare("SELECT COUNT(*) AS count FROM knowledge_keywords WHERE project_id=?").get(project.id)?.count,
			).toBe(0);
			expect(db.prepare("SELECT 1 FROM approvals WHERE id='delete-approval'").get()).toBeUndefined();
			expect(db.prepare("SELECT 1 FROM semantic_versions WHERE id=?").get(projectFact.id)).toBeUndefined();
			expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
		});
		await fixture.restart();
		expect(await fixture.application.services.projects.list()).toHaveLength(1);
		expect((await fixture.application.services.sessions.list()).map((session) => session.id).sort()).toEqual(
			[otherSession.id, personal.id].sort(),
		);
		expect((await fixture.request(`/projects/${project.id}/knowledge/documents/${document.id}/file`)).status).toBe(
			404,
		);
		expect((await fixture.application.services.semantic.list({})).some((fact) => fact.id === user.id)).toBe(true);
	} finally {
		await fixture.close();
	}
});

test("a changed project needs a fresh deletion preview and active real Pi runs block deletion", async () => {
	const fixture = await createAssistantFixture(undefined, { tokensPerSecond: 10 });
	try {
		const project = await linkedProject(fixture);
		const before = await preview(fixture, project);
		const session = await fixture.application.createSession({ projectId: project.id });
		expect((await remove(fixture, project, before.fingerprint)).status).toBe(409);
		expect(await fixture.application.repositories.projects.pendingDeletions()).toEqual([]);
		fixture.faux.setResponses([
			fauxAssistantMessage(
				"An active real Pi request should prevent deletion until its completion or cancellation.",
			),
		]);
		const submitted = await fixture.request(`/sessions/${session.id}/messages`, {
			method: "POST",
			body: JSON.stringify({ text: "运行期间核对删除保护" }),
		});
		expect(submitted.status).toBe(202);
		const { runId } = (await submitted.json()) as { runId: string };
		expect((await remove(fixture, project)).status).toBe(409);
		expect(await stat(project.memoryFilePath)).toBeDefined();
		await fixture.request(`/sessions/${session.id}/abort`, { method: "POST" });
		await (await fixture.request(`/runs/${runId}/events`)).text();
		expect((await remove(fixture, project)).status).toBe(200);
	} finally {
		await fixture.close();
	}
});

test("global user preferences survive project deletion and their actual context marks the removed Pi source as a retained excerpt", async () => {
	const fixture = await createAssistantFixture();
	try {
		const project = await linkedProject(fixture);
		const other = await fixture.application.createProject({ name: "继续复用用户偏好" });
		const sourceSession = await fixture.application.createSession({ projectId: project.id });
		const otherSession = await fixture.application.createSession({ projectId: other.id });
		const preference = "以后所有项目都先给结论，再给编号步骤。";
		fixture.faux.setResponses([fauxAssistantMessage("收到。")]);
		const submitted = await fixture.request(`/sessions/${sourceSession.id}/messages`, {
			method: "POST",
			body: JSON.stringify({ text: preference }),
		});
		expect(submitted.status).toBe(202);
		const { runId } = (await submitted.json()) as { runId: string };
		await (await fixture.request(`/runs/${runId}/events`)).text();
		const checkpoint = await fixture.application.services.memoryState.checkpoint(sourceSession.id);
		const source = checkpoint!.sources.find((item) => item.confirmation === "user_confirmed")!;
		expect(source.piEntryId).toBeDefined();
		const proposal = await fixture.application.services.memory.propose(
			{},
			{ kind: "user", proposedText: preference, reason: "用户长期偏好", evidence: [source] },
		);
		await fixture.application.services.memory.accept(proposal.id);
		const userFile = fixture.application.paths.userMemory;
		const before = await readFile(userFile, "utf8");
		const retrieve = () =>
			fixture.application.services.retrieval.retrieve({ sessionId: otherSession.id, query: "表达偏好" });
		expect((await retrieve()).memory.fragments.find((item) => item.id === proposal.id)?.sources[0].availability).toBe(
			"present",
		);
		expect((await remove(fixture, project)).status).toBe(200);
		await fixture.restart();
		const result = await retrieve();
		expect(result.memory.fragments.find((item) => item.id === proposal.id)?.sources[0]).toMatchObject({
			availability: "retained_excerpt",
			excerpt: preference,
			sessionId: sourceSession.id,
		});
		expect(result.memory.diagnostics.join("\n")).toContain("来源会话已删除");
		expect(await readFile(userFile, "utf8")).toBe(before);
	} finally {
		await fixture.close();
	}
});

test("file/SQLite deletion interruption leaves a durable journal and startup finishes cleanup without recreating project memory", async () => {
	const fixture = await createAssistantFixture();
	try {
		const project = await linkedProject(fixture);
		const session = await fixture.application.createSession({ projectId: project.id });
		const memory = await fixture.application.services.memory.propose(
			{ project },
			{ kind: "project", proposedText: "项目约束保留到删除。", reason: "确认" },
		);
		await fixture.application.services.memory.accept(memory.id);
		const fail = vi
			.spyOn(fixture.application.repositories.projects, "finishDeletion")
			.mockRejectedValueOnce(new Error("controlled database interruption"));
		expect((await remove(fixture, project)).status).toBe(500);
		fail.mockRestore();
		await expect(stat(project.workspacePath)).rejects.toMatchObject({ code: "ENOENT" });
		expect(await fixture.application.repositories.projects.pendingDeletions()).toHaveLength(1);
		expect(await (await fixture.request("/projects")).json()).toContainEqual(
			expect.objectContaining({ id: project.id, deletionPending: true }),
		);
		expect((await fixture.request(`/projects/${project.id}`)).status).toBe(409);
		await fixture.restart();
		expect(await fixture.application.repositories.projects.pendingDeletions()).toEqual([]);
		expect(await fixture.application.repositories.projects.get(project.id)).toBeUndefined();
		expect(await fixture.application.repositories.sessions.get(session.id)).toBeUndefined();
		await expect(stat(project.workspacePath)).rejects.toMatchObject({ code: "ENOENT" });
		expect(await readFile(join(project.sourcePath!, "保留.txt"), "utf8")).toBe("用户原有项目文件");
	} finally {
		await fixture.close();
	}
});

test("unmanaged paths and nested Windows junctions are rejected before deleting any project data", async () => {
	const fixture = await createAssistantFixture();
	try {
		const project = await linkedProject(fixture);
		const session = await fixture.application.createSession({ projectId: project.id });
		const link = join(project.workspacePath, "外部链接");
		await symlink(project.sourcePath!, link, process.platform === "win32" ? "junction" : "dir");
		try {
			expect((await remove(fixture, project)).status).toBe(403);
			expect(await fixture.application.repositories.projects.pendingDeletions()).toEqual([]);
			expect(await stat(session.runtimeRef)).toBeDefined();
			expect(await readFile(project.memoryFilePath, "utf8")).toContain("项目经验");
		} finally {
			await rm(link);
		}
		database(fixture, (db) =>
			db.prepare("UPDATE projects SET workspace_path=? WHERE id=?").run(project.sourcePath!, project.id),
		);
		expect((await remove(fixture, project)).status).toBe(403);
		expect(await fixture.application.repositories.projects.pendingDeletions()).toEqual([]);
		database(fixture, (db) =>
			db.prepare("UPDATE projects SET workspace_path=? WHERE id=?").run(project.workspacePath, project.id),
		);
		expect((await remove(fixture, project)).status).toBe(200);
		expect(await readFile(join(project.sourcePath!, "保留.txt"), "utf8")).toBe("用户原有项目文件");
	} finally {
		await fixture.close();
	}
});

test("an in-flight Gateway upload prevents deletion, and new requests cannot recreate data during cleanup", async () => {
	const fixture = await createAssistantFixture();
	try {
		const project = await linkedProject(fixture);
		const session = await fixture.application.createSession({ projectId: project.id });
		const confirmation = await preview(fixture, project);
		let release: () => void = () => undefined;
		const barrier = new Promise<void>((resolve) => {
			release = resolve;
		});
		const original = fixture.application.services.knowledge.upload.bind(fixture.application.services.knowledge);
		const upload = vi.spyOn(fixture.application.services.knowledge, "upload");
		upload.mockImplementation(async (...args) => {
			await barrier;
			return original(...args);
		});
		const uploading = fixture.request(`/projects/${project.id}/knowledge/documents?name=held.txt`, {
			method: "POST",
			headers: { "content-type": "application/octet-stream" },
			body: new Uint8Array(Buffer.from("held upload")),
		});
		await vi.waitFor(() => expect(upload).toHaveBeenCalled());
		expect((await remove(fixture, project, confirmation.fingerprint)).status).toBe(409);
		release();
		expect((await uploading).status).toBe(202);
		upload.mockRestore();
		await vi.waitFor(
			async () => expect(await fixture.application.services.knowledge.isBusy(project.id)).toBe(false),
			{ timeout: 15_000 },
		);
		let finish: () => void = () => undefined;
		const held = new Promise<void>((resolve) => {
			finish = resolve;
		});
		const deleteSession = fixture.application.services.sessions.delete.bind(fixture.application.services.sessions);
		const deletion = vi.spyOn(fixture.application.services.sessions, "delete").mockImplementation(async (id) => {
			await held;
			await deleteSession(id);
		});
		const deleting = remove(fixture, project);
		await vi.waitFor(() => expect(deletion).toHaveBeenCalledWith(session.id));
		expect(
			(await fixture.request("/sessions", { method: "POST", body: JSON.stringify({ projectId: project.id }) }))
				.status,
		).toBe(409);
		finish();
		expect((await deleting).status).toBe(200);
		deletion.mockRestore();
		expect(await fixture.application.repositories.projects.get(project.id)).toBeUndefined();
	} finally {
		vi.restoreAllMocks();
		await fixture.close();
	}
});
