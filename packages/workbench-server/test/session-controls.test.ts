import { access, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import type { WorkbenchSession } from "@earendil-works/workbench-core";
import type { ChatCapabilityCatalog } from "@earendil-works/workbench-core/contracts";
import { expect, test } from "vitest";
import { createAssistantFixture } from "./assistant-fixture.ts";

test("archives, restores and deletes real Pi history without deleting project outputs", async () => {
	const fixture = await createAssistantFixture();
	try {
		const project = await fixture.application.createProject({ name: "保留项目成果" });
		const session = await fixture.application.createSession({ projectId: project.id, title: "待归档会话" });
		const artifactPath = join(project.workspacePath, "artifacts", "保留报告.md");
		await writeFile(artifactPath, "保留的报告");
		await fixture.application.services.artifacts.register({
			projectId: project.id,
			sessionId: session.id,
			name: "报告",
			type: "report",
			workspaceRelativePath: `projects/${project.slug}/artifacts/保留报告.md`,
		});
		const task = await fixture.application.services.tasks.create({
			projectId: project.id,
			title: "保留任务",
			type: "agent",
		});
		await fixture.application.services.tasks.queueAgentRun(task.id, session.id);
		const candidate = await fixture.application.services.memory.propose(
			{ project },
			{ kind: "project", proposedText: "保留记忆", reason: "测试", sessionId: session.id },
		);
		const archived = await fixture.request(`/sessions/${session.id}/archive`, { method: "POST" });
		expect(archived.status).toBe(200);
		expect(((await archived.json()) as WorkbenchSession).archivedAt).toBeTruthy();
		expect(await (await fixture.request("/sessions")).json()).toEqual([]);
		await access(session.runtimeRef);
		expect(
			(
				await fixture.request(`/sessions/${session.id}/messages`, {
					method: "POST",
					body: JSON.stringify({ text: "不能运行归档会话" }),
				})
			).status,
		).toBe(409);
		await fixture.restart();
		const restored = await fixture.request(`/sessions/${session.id}/restore`, { method: "POST" });
		expect(restored.status).toBe(200);
		fixture.faux.setResponses([fauxAssistantMessage("恢复会话正常")]);
		const started = fixture.application.events.start(session.id, { text: "继续" });
		for await (const _event of fixture.application.events.subscribe(started.runId)) {
			// Wait for Pi to persist and settle before deleting.
		}
		expect(await fixture.application.services.sessions.readTranscript(session.id)).toHaveLength(2);
		const deleted = await fixture.request(`/sessions/${session.id}`, { method: "DELETE" });
		expect(deleted.status).toBe(200);
		await expect(access(session.runtimeRef)).rejects.toMatchObject({ code: "ENOENT" });
		expect((await fixture.request(`/sessions/${session.id}/transcript`)).status).toBe(404);
		expect((await fixture.request(`/runs/${started.runId}/events`)).status).toBe(404);
		expect(await readFile(artifactPath, "utf8")).toBe("保留的报告");
		expect((await fixture.application.services.artifacts.list(project.id))[0].sessionId).toBeUndefined();
		expect((await fixture.application.services.tasks.get(task.id)).title).toBe("保留任务");
		expect((await fixture.application.repositories.taskRuns.list(task.id))[0].sessionId).toBeUndefined();
		expect((await fixture.application.repositories.memory.getCandidate(candidate.id))?.proposedText).toBe("保留记忆");
		await fixture.restart();
		expect(await fixture.application.services.sessions.list()).toEqual([]);
	} finally {
		await fixture.close();
	}
});

test("an imported unbound Skill is selectable after restart and Pi chooses tools automatically", async () => {
	const fixture = await createAssistantFixture();
	try {
		const source = join(fixture.root, "source", "ask-matt");
		await mkdir(source, { recursive: true });
		await writeFile(
			join(source, "SKILL.md"),
			"---\nname: ask-matt\ndescription: 显式调用流程\n---\nEXPLICIT_SKILL_CONTENT: follow the evidence checklist.",
		);
		const preview = await fixture.application.services.skillImports.preview({
			source: "local",
			location: source,
			scope: "global",
		});
		const {
			skills: [skill],
		} = await fixture.application.services.skillImports.commitImport(preview.id, ["ask-matt"]);
		const profile = await fixture.application.services.profiles.create({
			name: "明确选择助手",
			systemPrompt: "完成用户请求",
			tools: ["task_list"],
			skillIds: [],
		});
		const session = await fixture.application.createSession({ profileId: profile.id });
		await fixture.restart();
		const catalog = (await (
			await fixture.request(`/chat-capabilities?sessionId=${session.id}`)
		).json()) as ChatCapabilityCatalog;
		expect(catalog.items).toContainEqual(expect.objectContaining({ id: skill.id, kind: "skill", name: "ask-matt" }));
		expect(catalog.items.every((item) => item.kind === "skill")).toBe(true);
		for (const selection of [
			{ toolIds: ["powershell"] },
			{ skillId: "unbound-skill" },
			{ toolIds: ["task_list", "task_list"] },
		]) {
			expect(
				(
					await fixture.request(`/sessions/${session.id}/messages`, {
						method: "POST",
						body: JSON.stringify({ text: "越权选择", selection }),
					})
				).status,
			).toBe(400);
		}
		fixture.faux.setResponses([
			(context) => {
				expect(context.systemPrompt).not.toContain("用户为本轮明确选择了这些工具");
				expect(JSON.stringify(context.messages.at(-1))).toContain("EXPLICIT_SKILL_CONTENT");
				expect(JSON.stringify(context.messages.at(-1))).toContain("<skill name=");
				expect(context.tools?.map((tool) => tool.name)).toEqual(["task_list"]);
				return fauxAssistantMessage(fauxToolCall("task_list", {}, { id: "selected-tool" }), {
					stopReason: "toolUse",
				});
			},
			fauxAssistantMessage("按流程查看任务完成"),
		]);
		const response = await fixture.request(`/sessions/${session.id}/messages`, {
			method: "POST",
			body: JSON.stringify({ text: "按流程查看任务", selection: { skillId: skill.id } }),
		});
		expect(response.status).toBe(202);
		const { runId } = (await response.json()) as { runId: string };
		const events = [];
		for await (const entry of fixture.application.events.subscribe(runId)) events.push(entry.event);
		expect(events.find((event) => event.type === "run.started")?.data.historyMessageCount).toBe(0);
		expect(events.find((event) => event.type === "run.failed")).toBeUndefined();
		expect(events.some((event) => event.type === "tool.completed" && !event.data.isError)).toBe(true);
		expect(events.some((event) => event.type === "run.completed")).toBe(true);
		const transcript = await fixture.application.services.sessions.readTranscript(session.id);
		expect(transcript[0].content).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ type: "skill", skillName: skill.name }),
				{ type: "text", text: "按流程查看任务" },
			]),
		);
		expect((await fixture.application.repositories.agentRuns.get(runId))?.capabilities).toMatchObject({
			requested: { skillId: skill.id },
		});
		fixture.faux.setResponses([
			(context) => {
				expect(context.systemPrompt).not.toContain("用户为本轮明确选择");
				expect(JSON.stringify(context.messages.at(-1))).not.toContain("EXPLICIT_SKILL_CONTENT");
				return fauxAssistantMessage("下一轮恢复正常");
			},
		]);
		const next = fixture.application.events.start(session.id, { text: "正常一轮" });
		for await (const _entry of fixture.application.events.subscribe(next.runId)) {
			/* drain */
		}
	} finally {
		await fixture.close();
	}
});

test("session titles validate, rename without changing history and survive restart", async () => {
	const fixture = await createAssistantFixture();
	try {
		for (const title of ["   ", "x".repeat(201)]) {
			expect((await fixture.request("/sessions", { method: "POST", body: JSON.stringify({ title }) })).status).toBe(
				400,
			);
		}
		const session = await fixture.application.createSession({ title: "论文研究" });
		fixture.faux.setResponses([fauxAssistantMessage("历史保留")]);
		const run = fixture.application.events.start(session.id, { text: "开始研究" });
		for await (const _entry of fixture.application.events.subscribe(run.runId)) {
			/* drain */
		}
		const history = await readFile(session.runtimeRef, "utf8");
		for (const title of ["", " \n ", "x".repeat(201)]) {
			expect(
				(await fixture.request(`/sessions/${session.id}/title`, { method: "PUT", body: JSON.stringify({ title }) }))
					.status,
			).toBe(400);
		}
		const response = await fixture.request(`/sessions/${session.id}/title`, {
			method: "PUT",
			body: JSON.stringify({ title: "  CV Learning 昨日进展  " }),
		});
		expect(response.status).toBe(200);
		expect(((await response.json()) as WorkbenchSession).title).toBe("CV Learning 昨日进展");
		expect(
			(
				await fixture.request(`/sessions/${session.id}/title`, {
					method: "PUT",
					body: JSON.stringify({ title: "过期修改", expectedTitle: session.title }),
				})
			).status,
		).toBe(409);
		expect(await readFile(session.runtimeRef, "utf8")).toBe(history);
		await fixture.restart();
		const restored = await fixture.application.services.sessions.get(session.id);
		expect(restored.title).toBe("CV Learning 昨日进展");
		expect(restored.runtimeSessionId).toBe(session.runtimeSessionId);
		expect(await fixture.application.services.sessions.readTranscript(session.id)).toHaveLength(2);
	} finally {
		await fixture.close();
	}
});

test("explicit Skills respect scope, disable and conflicting native names", async () => {
	const fixture = await createAssistantFixture();
	try {
		const project = await fixture.application.createProject({ name: "技能范围" });
		const other = await fixture.application.createProject({ name: "其他范围" });
		const skill = await fixture.application.services.skills.create({
			slug: "project-only",
			name: "项目技能",
			description: "仅本项目",
			scope: "project",
			project,
		});
		const session = await fixture.application.createSession({ projectId: project.id });
		const unrelated = await fixture.application.createSession({ projectId: other.id });
		expect((await fixture.application.chatCapabilities({ sessionId: session.id })).items).toContainEqual(
			expect.objectContaining({ id: skill.id }),
		);
		expect((await fixture.application.chatCapabilities({ sessionId: unrelated.id })).items).not.toContainEqual(
			expect.objectContaining({ id: skill.id }),
		);
		await expect(
			fixture.application.services.sessions.prepareInvocation(unrelated.id, "测试", { skillId: skill.id }),
		).rejects.toMatchObject({ code: "invalid_input" });
		await fixture.application.services.skills.setEnabled(skill.id, false);
		await expect(
			fixture.application.services.sessions.prepareInvocation(session.id, "测试", { skillId: skill.id }),
		).rejects.toMatchObject({ code: "invalid_input" });
		const global = await fixture.application.services.skills.create({
			slug: "same-name",
			name: "全局流程",
			description: "全局版本",
			instructions: "GLOBAL_DEFAULT",
			scope: "global",
		});
		const local = await fixture.application.services.skills.create({
			slug: "same-name",
			name: "项目流程",
			description: "项目版本",
			instructions: "PROJECT_OVERRIDE",
			scope: "project",
			project,
		});
		const profile = await fixture.application.services.profiles.create({
			name: "同名流程助手",
			systemPrompt: "工作",
			tools: [],
			skillIds: [global.id],
		});
		const scoped = await fixture.application.createSession({ profileId: profile.id, projectId: project.id });
		fixture.faux.setResponses([
			(context) => {
				expect(JSON.stringify(context.messages.at(-1))).toContain("PROJECT_OVERRIDE");
				expect(JSON.stringify(context.messages.at(-1))).not.toContain("GLOBAL_DEFAULT");
				return fauxAssistantMessage("已使用选定的项目版本");
			},
		]);
		const run = fixture.application.events.start(scoped.id, {
			text: "使用项目流程",
			selection: { skillId: local.id },
		});
		const events = [];
		for await (const entry of fixture.application.events.subscribe(run.runId)) events.push(entry.event);
		expect(events.at(-1)?.type).toBe("run.completed");
	} finally {
		await fixture.close();
	}
});

test("an active approval allows renaming but blocks archive and deletion; recovery tolerates a removed history file", async () => {
	const fixture = await createAssistantFixture();
	try {
		const session = await fixture.application.createSession({ profileSlug: "standard" });
		fixture.faux.setResponses([
			fauxAssistantMessage(
				fauxToolCall("powershell", { command: "Write-Output test" }, { id: "waiting-approval" }),
				{ stopReason: "toolUse" },
			),
		]);
		const run = fixture.application.events.start(session.id, { text: "等候批准" });
		await expect.poll(async () => (await fixture.application.repositories.approvals.listPending()).length).toBe(1);
		expect((await fixture.request(`/sessions/${session.id}/archive`, { method: "POST" })).status).toBe(409);
		expect(
			(
				await fixture.request(`/sessions/${session.id}/title`, {
					method: "PUT",
					body: JSON.stringify({ title: "运行中修改" }),
				})
			).status,
		).toBe(200);
		expect((await fixture.request(`/sessions/${session.id}`, { method: "DELETE" })).status).toBe(409);
		expect((await fixture.application.repositories.approvals.listPending()).length).toBe(1);
		expect(await fixture.application.services.sessions.get(session.id)).toMatchObject({
			title: "运行中修改",
			status: "running",
		});
		await fixture.application.events.abort(session.id);
		for await (const _entry of fixture.application.events.subscribe(run.runId)) {
			/* drain */
		}
		const current = await fixture.application.services.sessions.get(session.id);
		expect(current.title).toBe("运行中修改");
		await fixture.application.runtime.releaseSession(session.runtimeSessionId);
		await fixture.application.repositories.sessions.update({
			...current,
			deletionRequestedAt: new Date().toISOString(),
		});
		await unlink(session.runtimeRef);
		await fixture.restart();
		expect(await fixture.application.services.sessions.list()).toEqual([]);
		expect(await fixture.application.repositories.sessions.get(session.id)).toBeUndefined();
	} finally {
		await fixture.close();
	}
});

test("Pi deletion validates file boundary, session identity and project cwd", async () => {
	const fixture = await createAssistantFixture();
	try {
		const session = await fixture.application.createSession({});
		const options = {
			reference: { runtime: "pi", runtimeSessionId: session.runtimeSessionId, opaque: session.runtimeRef },
			expectedCwd: session.cwd,
			kind: session.kind,
		};
		await expect(
			fixture.application.runtime.deleteSessionReference({ ...options, expectedCwd: join(fixture.root, "wrong") }),
		).rejects.toMatchObject({ code: "invalid_reference" });
		await expect(
			fixture.application.runtime.deleteSessionReference({
				...options,
				reference: { ...options.reference, runtimeSessionId: "wrong-id" },
			}),
		).rejects.toMatchObject({ code: "invalid_reference" });
		const external = join(fixture.root, "external.jsonl");
		await writeFile(external, "must remain");
		await expect(
			fixture.application.runtime.deleteSessionReference({
				...options,
				reference: { ...options.reference, opaque: external },
			}),
		).rejects.toMatchObject({ code: "invalid_reference" });
		expect(await readFile(external, "utf8")).toBe("must remain");
		await access(session.runtimeRef);
	} finally {
		await fixture.close();
	}
});

test("a rejected deletion stays visible and an invalid pending reference cannot block startup", async () => {
	const fixture = await createAssistantFixture();
	try {
		const session = await fixture.application.createSession({ title: "无效引用" });
		await fixture.application.repositories.sessions.update({ ...session, runtimeSessionId: "wrong-id" });
		await expect(fixture.application.services.sessions.delete(session.id)).rejects.toMatchObject({
			code: "invalid_reference",
		});
		const visible = await fixture.application.services.sessions.get(session.id);
		expect(visible.status).toBe("unavailable");
		expect(visible.deletionRequestedAt).toBeUndefined();
		await access(session.runtimeRef);
		await fixture.application.repositories.sessions.update({
			...visible,
			deletionRequestedAt: new Date().toISOString(),
		});
		await fixture.restart();
		expect(await fixture.application.services.sessions.list()).toHaveLength(1);
		expect((await fixture.application.services.sessions.get(session.id)).status).toBe("unavailable");
		await access(session.runtimeRef);
	} finally {
		await fixture.close();
	}
});
