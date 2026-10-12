import { readdir, readFile, rmdir } from "node:fs/promises";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import type { LearningReview } from "@earendil-works/workbench-core/contracts";
import { WorkbenchDatabase } from "@earendil-works/workbench-database";
import { Type } from "typebox";
import { Parse } from "typebox/value";
import { expect, test, vi } from "vitest";
import { createAssistantFixture } from "./assistant-fixture.ts";
import { completeLearningTask, LEARNED_FACT, type LearningFixture, reviewOutput } from "./project-learning-fixture.ts";

async function send(fixture: LearningFixture, sessionId: string, text: string) {
	const response = await fixture.request(`/sessions/${sessionId}/messages`, {
		method: "POST",
		body: JSON.stringify({ text }),
	});
	expect(response.status).toBe(202);
	const run = Parse(Type.Object({ runId: Type.String() }), await response.json());
	const stream = await (await fixture.request(`/runs/${run.runId}/events`)).text();
	expect(stream).toContain('"type":"run.completed"');
	return run.runId;
}

async function finished(fixture: LearningFixture, projectId: string): Promise<LearningReview> {
	let review: LearningReview | undefined;
	await vi.waitFor(
		async () => {
			review = (await fixture.application.services.learning.list(projectId))[0];
			expect(review).toBeDefined();
			expect(["queued", "running"]).not.toContain(review!.status);
			expect(review!.changes.every((change) => change.status === "applied")).toBe(true);
		},
		{ timeout: 15000 },
	);
	return review!;
}

test("a closing prompt reviews the accumulated real Pi evidence once, before the periodic interval", async () => {
	const fixture = await createAssistantFixture();
	try {
		const project = await fixture.application.createProject({ name: "自然收尾 中文 空格" });
		const { session, runId: taskRun } = await completeLearningTask(fixture, project.id, "deferred");
		await fixture.application.services.learning.configure(project.id, { memoryInterval: 10, skillInterval: 10 });
		expect(await fixture.application.services.learning.list(project.id)).toEqual([]);
		fixture.faux.setResponses([
			fauxAssistantMessage("目录检查已完成，项目环境已确认。"),
			(context) => {
				expect(context.tools).toHaveLength(0);
				expect(context.systemPrompt).toContain("项目经验审核员");
				const output = reviewOutput(context);
				expect(output.memories[0].evidence[0].sourceId).toMatch(/^source-\d+$/u);
				return fauxAssistantMessage(JSON.stringify(output));
			},
		]);
		const closingRun = await send(fixture, session.id, "请总结一下这次任务");
		const review = await finished(fixture, project.id);
		expect(review).toMatchObject({ origin: "prompt", mode: "auto", sourceRunId: closingRun });
		expect(review.sourceRunIds).toEqual([taskRun, closingRun]);
		expect(review.changes).toHaveLength(2);
		expect(review.changes[0].verifiedRunIds).toEqual([taskRun]);
		const snapshot = await fixture.application.repositories.learning.getSnapshot(review.sourceKey);
		for (const change of review.changes)
			for (const evidence of change.evidence) {
				expect(snapshot!.sources.some((source) => source.id === evidence.sourceId)).toBe(true);
				expect(evidence.sourceId).not.toMatch(/^source-\d+$/u);
			}
		expect(await readFile(project.memoryFilePath, "utf8")).toContain(LEARNED_FACT);
		const [skill] = await fixture.application.services.learning.reusableSkills(project.id);
		expect(skill.path).toBe(join(project.workspacePath, "skills", skill.slug, "SKILL.md"));
		expect(await readFile(skill.path, "utf8")).toContain("## 验证");
		const run = (await fixture.application.repositories.agentRuns.get(closingRun))!;
		expect(
			await fixture.application.services.learning.onRunSettled({
				id: "duplicate-closing",
				type: "run.completed",
				sessionId: session.id,
				runId: closingRun,
				occurredAt: run.settledAt!,
				data: {},
			}),
		).toBe(false);
		expect(await fixture.application.services.learning.list(project.id)).toHaveLength(1);
		expect((await fixture.application.services.learning.schedule(project.id))[0].turns).toBe(0);
		expect(fixture.faux.getPendingResponseCount()).toBe(0);
	} finally {
		await fixture.close();
	}
});

test("prompt and periodic reviews coexist across restart and consume separate evidence windows", async () => {
	const fixture = await createAssistantFixture();
	try {
		const project = await fixture.application.createProject({ name: "手动与自动复盘并存" });
		// The shared fixture disables auxiliary requests; enable the production cadence for this test.
		await fixture.application.services.learning.configure(project.id, { memoryInterval: 10, skillInterval: 10 });
		expect(await fixture.application.services.learning.settings(project.id)).toMatchObject({
			memoryInterval: 10,
			skillInterval: 10,
		});
		const session = await fixture.application.createSession({ projectId: project.id });
		const emptyReview = () => [
			fauxAssistantMessage("已完成当前回答。"),
			(context: Parameters<typeof reviewOutput>[0]) => {
				expect(context.tools).toHaveLength(0);
				expect(context.systemPrompt).toContain("项目经验审核员");
				return fauxAssistantMessage(JSON.stringify({ summary: "没有重要新经验", memories: [], skills: [] }));
			},
		];
		fixture.faux.setResponses([fauxAssistantMessage("收到。")]);
		const firstRun = await send(fixture, session.id, "仅确认收到，不需要保存长期经验。");
		fixture.faux.setResponses(emptyReview());
		const promptRun = await send(fixture, session.id, "总结这次任务");
		const prompted = await finished(fixture, project.id);
		expect(prompted).toMatchObject({ origin: "prompt", mode: "auto", status: "empty" });
		expect(prompted.sourceRunIds).toEqual([firstRun, promptRun]);
		expect((await fixture.application.services.learning.schedule(project.id))[0].turns).toBe(0);
		await fixture.restart();
		expect((await fixture.application.services.sessions.get(session.id)).runtimeSessionId).toBe(
			session.runtimeSessionId,
		);
		const periodicRuns: string[] = [];
		for (let index = 0; index < 10; index++) {
			fixture.faux.setResponses(index === 9 ? emptyReview() : [fauxAssistantMessage("收到。")]);
			periodicRuns.push(await send(fixture, session.id, `普通问答 ${index + 1}`));
			if (index < 9) expect(await fixture.application.services.learning.list(project.id)).toHaveLength(1);
		}
		await vi.waitFor(async () =>
			expect(await fixture.application.services.learning.list(project.id)).toHaveLength(2),
		);
		const periodic = await finished(fixture, project.id);
		expect(periodic).toMatchObject({
			origin: "periodic",
			mode: "auto",
			status: "empty",
			sourceRunId: periodicRuns.at(-1),
		});
		expect(periodic.sourceRunIds).toEqual(periodicRuns);
		expect(periodic.sourceRunIds).not.toContain(promptRun);
		expect((await fixture.application.services.learning.schedule(project.id))[0].turns).toBe(0);
		fixture.faux.setResponses(emptyReview());
		const nextPromptRun = await send(fixture, session.id, "请复盘本次工作");
		await vi.waitFor(async () =>
			expect(await fixture.application.services.learning.list(project.id)).toHaveLength(3),
		);
		const nextPrompted = await finished(fixture, project.id);
		expect(nextPrompted).toMatchObject({ origin: "prompt", mode: "auto", status: "empty" });
		expect(nextPrompted.sourceRunIds).toEqual([nextPromptRun]);
		expect(fixture.faux.getPendingResponseCount()).toBe(0);
	} finally {
		await fixture.close();
	}
});

test("quoted examples and document summaries do not close a task; an explicit refusal suppresses that turn", async () => {
	const fixture = await createAssistantFixture();
	try {
		const project = await fixture.application.createProject({ name: "收尾边界" });
		await fixture.application.services.learning.configure(project.id, { memoryInterval: 10, skillInterval: 10 });
		const session = await fixture.application.createSession({ projectId: project.id });
		for (const text of [
			"总结这篇文章",
			"说明如何使用“总结这次任务”",
			"> 总结这次任务\n检查引用",
			"请总结任务调度算法",
		]) {
			fixture.faux.setResponses([fauxAssistantMessage("已回答当前问题。")]);
			await send(fixture, session.id, text);
		}
		expect(await fixture.application.services.learning.list(project.id)).toEqual([]);
		await fixture.application.services.learning.configure(project.id, { memoryInterval: 1 });
		fixture.faux.setResponses([fauxAssistantMessage("仅总结结果。")]);
		await send(fixture, session.id, "总结这次任务，但不要复盘或保存经验。");
		expect(await fixture.application.services.learning.list(project.id)).toEqual([]);
		expect(fixture.faux.getPendingResponseCount()).toBe(0);
	} finally {
		await fixture.close();
	}
});

test("only automatic learning is exposed; old switches and internal intervals cannot be set through Gateway", async () => {
	const fixture = await createAssistantFixture();
	try {
		const project = await fixture.application.createProject({ name: "后台学习接口" });
		const settings = await (await fixture.request("/settings")).text();
		expect(settings).not.toContain("learning.");
		for (const mode of ["off", "review", "auto"]) {
			expect(
				(
					await fixture.request(`/projects/${project.id}/learning`, {
						method: "PUT",
						body: JSON.stringify({ mode, expectedVersion: 0 }),
					})
				).status,
			).toBe(404);
		}
		for (const key of ["learning.defaultMode", `learning.project.${project.id}`, `learning.schedule.${project.id}`]) {
			expect(
				(
					await fixture.request(`/settings/${key}`, {
						method: "PUT",
						body: JSON.stringify({ value: "off" }),
					})
				).status,
			).toBe(400);
		}
		await expect(fixture.application.services.settings.set("learning.defaultMode", "off")).rejects.toThrow(
			"仅使用后台自动学习",
		);
		expect((await fixture.application.services.learning.settings(project.id)).mode).toBe("auto");
	} finally {
		await fixture.close();
	}
});

test("one-time history reset recovers skill writes first and preserves facts, skills and the same Pi session", async () => {
	const fixture = await createAssistantFixture();
	try {
		const project = await fixture.application.createProject({ name: "历史清理保留经验" });
		const empty = await fixture.application.createProject({ name: "旧项目空目录" });
		await rmdir(join(empty.workspacePath, "skills"));
		const { session, runId } = await completeLearningTask(fixture, project.id);
		const review = await finished(fixture, project.id);
		const change = review.changes.find((item) => item.kind === "skill")!;
		const content = await readFile(join(fixture.application.paths.workspace, change.relativePath), "utf8");
		const facts = await fixture.application.services.semantic.list({ project });
		// Simulate a committed file whose applying journal/ownership was not yet finalized.
		await fixture.application.repositories.learning.save(
			{
				...review,
				version: review.version + 1,
				changes: review.changes.map((item) => (item.id === change.id ? { ...item, status: "applying" } : item)),
			},
			review.version,
		);
		const database = new WorkbenchDatabase(fixture.application.paths.database);
		try {
			database.prepare("DELETE FROM learning_skill_state WHERE skill_id = ?").run(change.skillId!);
		} finally {
			database.close();
		}
		await fixture.application.services.settings.set("learning.historyResetPending", true);
		await fixture.restart();
		expect(await fixture.application.services.learning.list(project.id)).toEqual([]);
		expect(await fixture.application.repositories.learning.getSnapshot(review.sourceKey)).toBeUndefined();
		expect(await fixture.application.services.learning.schedule(project.id)).toEqual([]);
		expect(await fixture.application.services.settings.get("learning.historyResetPending")).toBeUndefined();
		const [state] = await fixture.application.repositories.learning.skillStates(project.id);
		expect(state).toMatchObject({ status: "managed", version: 1, skillId: change.skillId });
		expect(state.reviewId).toBeUndefined();
		expect(state.changeId).toBeUndefined();
		expect(await readFile(join(fixture.application.paths.workspace, change.relativePath), "utf8")).toBe(content);
		expect(await fixture.application.services.semantic.list({ project })).toEqual(facts);
		expect((await fixture.application.services.sessions.get(session.id)).runtimeSessionId).toBe(
			session.runtimeSessionId,
		);
		expect(await readFile(session.runtimeRef, "utf8")).toContain("已检查项目目录");
		expect(await readdir(join(empty.workspacePath, "skills"))).toEqual([]);
		const run = (await fixture.application.repositories.agentRuns.get(runId))!;
		expect(
			await fixture.application.services.learning.onRunSettled({
				id: "old-run-replay",
				type: "run.completed",
				sessionId: session.id,
				runId,
				occurredAt: run.settledAt!,
				data: {},
			}),
		).toBe(false);
		fixture.faux.setResponses([
			fauxAssistantMessage("任务总结完成，没有重要新信息。"),
			fauxAssistantMessage(JSON.stringify({ summary: "无新经验", memories: [], skills: [] })),
		]);
		await send(fixture, session.id, "总结这次任务");
		const subsequent = await finished(fixture, project.id);
		expect(subsequent.status).toBe("empty");
		await fixture.restart();
		expect((await fixture.application.services.learning.list(project.id)).map((item) => item.id)).toEqual([
			subsequent.id,
		]);
	} finally {
		await fixture.close();
	}
});
