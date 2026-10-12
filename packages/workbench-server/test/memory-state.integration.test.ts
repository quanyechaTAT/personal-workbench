import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { toolEvidence } from "@earendil-works/workbench-core";
import { expect, test } from "vitest";
import { createAssistantFixture } from "./assistant-fixture.ts";

test("concurrent real Pi sessions isolate checkpoints, protect versions and resume the same history after compaction/restart", async () => {
	const fixture = await createAssistantFixture();
	try {
		const a = await fixture.application.createSession({});
		const b = await fixture.application.createSession({});
		fixture.faux.setResponses([
			(context) =>
				fauxAssistantMessage(
					JSON.stringify(context).includes("会话甲") ? "甲的临时结论尚未验证" : "乙的临时结论尚未验证",
					{ timestamp: 0 },
				),
			fauxAssistantMessage("乙的进度"),
		]);
		const ar = fixture.application.events.start(a.id, { text: "会话甲目标：完成图像实验\n约束：不要提交" });
		const br = fixture.application.events.start(b.id, { text: "会话乙目标：音频实验" });
		await Promise.all([drain(fixture, ar.runId), drain(fixture, br.runId)]);
		const first = await fixture.application.services.memoryState.checkpoint(a.id);
		const second = await fixture.application.services.memoryState.checkpoint(b.id);
		expect(first?.goal).toContain("会话甲");
		expect(JSON.stringify(first)).not.toContain("会话乙");
		expect(JSON.stringify(second)).not.toContain("会话甲");
		expect(first?.constraints).toEqual(["约束：不要提交"]);
		expect(first?.temporaryConclusions[0]?.confirmation).toBe("unverified");
		expect(first?.temporaryConclusions[0]?.text).toContain("甲的临时结论");
		expect(first?.sources.some((source) => source.piEntryId)).toBe(true);
		if (!first) throw new Error("Checkpoint missing");
		expect(
			await fixture.application.repositories.memoryState.saveCheckpoint(
				{ ...first, goal: "late overwrite", version: first.version },
				first.version - 1,
			),
		).toBeUndefined();
		await fixture.restart();
		expect((await fixture.application.services.sessions.get(a.id)).runtimeSessionId).toBe(a.runtimeSessionId);
		expect((await fixture.application.services.memoryState.checkpoint(a.id))?.goal).toBe(first.goal);
		await writeFile(
			join(fixture.root, "pi-agent", "settings.json"),
			JSON.stringify({ compaction: { keepRecentTokens: 1 } }),
		);
		const manager = SessionManager.open(a.runtimeRef);
		manager.appendMessage({ role: "user", content: "检查压缩后续接 ".repeat(800), timestamp: Date.now() });
		manager.appendMessage({
			...fauxAssistantMessage("保留重要目标 ".repeat(400)),
			provider: fixture.model.provider,
			model: fixture.model.id,
			api: fixture.model.api,
		});
		fixture.faux.setResponses([
			(context) => {
				expect(JSON.stringify(context)).toContain("会话甲目标");
				expect(JSON.stringify(context)).toContain("不要提交");
				return fauxAssistantMessage("目标、约束和进度保留。需要继续验证。");
			},
		]);
		await fixture.application.services.sessions.executeCommand(a.id, { name: "compact" });
		const before = await fixture.application.services.memoryState.checkpoint(a.id);
		fixture.faux.setResponses([
			(context) => {
				const replay = JSON.stringify(context);
				expect(replay).toContain("workbench-working-memory");
				expect(replay).toContain("会话甲目标");
				expect(replay).not.toContain("会话乙");
				return fauxAssistantMessage("恢复检查点并继续验证");
			},
		]);
		const continued = fixture.application.events.start(a.id, { text: "继续" });
		await drain(fixture, continued.runId);
		expect((await fixture.application.services.memoryState.checkpoint(a.id))?.goal).toBe(before?.goal);
		expect(await readFile(a.runtimeRef, "utf8")).not.toContain("workbench-working-memory");
	} finally {
		await fixture.close();
	}
}, 30_000);

test("failed tools retain episodic evidence without promoting outcomes; cleanup preserves history and minimal stays fixed", async () => {
	const fixture = await createAssistantFixture();
	try {
		const project = await fixture.application.createProject({ name: "失败经历 中文" });
		const session = await fixture.application.createSession({ projectId: project.id });
		fixture.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("read", { path: "missing.txt" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("失败后提出的解决办法尚未验证"),
		]);
		const run = fixture.application.events.start(session.id, { text: "完成项目任务：读取缺失文件" });
		await drain(fixture, run.runId);
		const episodes = await fixture.application.services.memoryState.episodes(session.id);
		expect(episodes).toHaveLength(1);
		expect(episodes[0]?.outcome).toBe("failure");
		expect(episodes[0]?.skillIds).toEqual([]);
		expect(await fixture.application.services.memoryState.exportEpisode(episodes[0]!.id, session.id)).toContain(
			"未验证",
		);
		const unrelated = await fixture.application.createProject({ name: "其他项目" });
		const other = await fixture.application.createSession({ projectId: unrelated.id });
		expect(await fixture.application.services.memoryState.episodes(other.id)).toEqual([]);
		const checkpoint = await fixture.application.services.memoryState.checkpoint(session.id);
		if (!checkpoint) throw new Error("Checkpoint missing");
		await fixture.application.repositories.memoryState.saveCheckpoint(
			{ ...checkpoint, expiresAt: "2000-01-01T00:00:00.000Z", version: checkpoint.version + 1 },
			checkpoint.version,
		);
		expect(await fixture.application.services.memoryState.cleanup()).toBe(1);
		expect(await readFile(session.runtimeRef, "utf8")).toContain("missing.txt");
		expect((await fixture.application.services.memoryState.episodes(session.id)).length).toBe(1);
		const minimal = await fixture.application.createSession({ profileSlug: "minimal" });
		fixture.faux.setResponses([fauxAssistantMessage("极简回应")]);
		await drain(fixture, fixture.application.events.start(minimal.id, { text: "极简会话" }).runId);
		expect(await fixture.application.services.memoryState.checkpoint(minimal.id)).toBeUndefined();
		expect(
			toolEvidence(
				{
					content: [{ type: "text", text: "outer success" }],
					details: {
						ptcCalls: [
							{
								arguments: { secret: "PARAMETERS-MUST-NOT-REVIEW" },
								isError: true,
								result: { content: [{ type: "text", text: "child failed" }] },
							},
						],
					},
				},
				false,
			),
		).toEqual({ failed: true, text: "child failed" });
	} finally {
		await fixture.close();
	}
});

async function drain(fixture: Awaited<ReturnType<typeof createAssistantFixture>>, runId: string) {
	for await (const _event of fixture.application.events.subscribe(runId)) {
		/* drain */
	}
}

test.each(["继续", "重启后继续", "压缩后请继续"])(
	"explicit user next steps and unresolved questions survive %s after a completed turn",
	async (continuation) => {
		const fixture = await createAssistantFixture();
		try {
			const session = await fixture.application.createSession({});
			fixture.faux.setResponses([
				fauxAssistantMessage(fauxToolCall("ls", { path: "." }), { stopReason: "toolUse" }),
				fauxAssistantMessage("目录已读取，发布日期尚未确定。"),
			]);
			await drain(
				fixture,
				fixture.application.events.start(session.id, {
					text: "目标：核对发布文件\n约束：不要修改源文件\n下一步：等待用户提供日期\n未解决问题：实际发布日期待确认",
				}).runId,
			);
			const checkpoint = await fixture.application.services.memoryState.checkpoint(session.id);
			expect(checkpoint?.nextSteps).toEqual(["下一步：等待用户提供日期"]);
			expect(checkpoint?.unresolvedQuestions).toEqual(["未解决问题：实际发布日期待确认"]);
			await fixture.restart();
			fixture.faux.setResponses([
				(context) => {
					const messages = JSON.stringify(context.messages);
					expect(messages).toContain("实际发布日期待确认");
					expect(messages).toContain("等待用户提供日期");
					return fauxAssistantMessage("继续等待日期，未重新执行工具。");
				},
			]);
			await drain(
				fixture,
				fixture.application.events.start(session.id, { text: `${continuation}，只说明当前待办，不调用工具` }).runId,
			);
			expect((await fixture.application.services.memoryState.checkpoint(session.id))?.goal).toBe(checkpoint?.goal);
			expect((await fixture.application.services.memoryState.checkpoint(session.id))?.nextSteps).toEqual(
				checkpoint?.nextSteps,
			);
			expect((await fixture.application.services.memoryState.checkpoint(session.id))?.unresolvedQuestions).toEqual(
				checkpoint?.unresolvedQuestions,
			);
		} finally {
			await fixture.close();
		}
	},
);

test("a crash boundary restores an interrupted checkpoint and one unverified episode without deleting Pi history", async () => {
	const fixture = await createAssistantFixture();
	try {
		const session = await fixture.application.createSession({});
		fixture.faux.setResponses([fauxAssistantMessage("等待下一步验证。")]);
		await drain(
			fixture,
			fixture.application.events.start(session.id, { text: "工作目标：检查上下文\n约束：不要提交" }).runId,
		);
		const old = (await fixture.application.services.memoryState.checkpoint(session.id))!;
		await fixture.application.repositories.memoryState.saveCheckpoint(
			{ ...old, runId: "crash-run", status: "running", review: { status: "running" }, version: old.version + 1 },
			old.version,
		);
		const history = await readFile(session.runtimeRef, "utf8");
		await fixture.restart();
		expect(await fixture.application.services.memoryState.checkpoint(session.id)).toMatchObject({
			status: "interrupted",
			review: { status: "interrupted" },
			goal: old.goal,
		});
		expect(
			(await fixture.application.services.memoryState.episodes(session.id)).filter(
				(value) => value.runId === "crash-run",
			),
		).toHaveLength(1);
		await fixture.restart();
		expect(
			(await fixture.application.services.memoryState.episodes(session.id)).filter(
				(value) => value.runId === "crash-run",
			),
		).toHaveLength(1);
		expect(await readFile(session.runtimeRef, "utf8")).toBe(history);
	} finally {
		await fixture.close();
	}
});

test("automatic compaction keeps checkpoint goals, verified progress and unresolved questions even when its model summary claims completion", async () => {
	const fixture = await createAssistantFixture(undefined, { modelContextWindow: 128000 });
	try {
		await writeFile(
			join(fixture.root, "pi-agent", "settings.json"),
			JSON.stringify({ compaction: { keepRecentTokens: 1 } }),
		);
		const session = await fixture.application.createSession({});
		fixture.faux.setResponses([
			() => fauxAssistantMessage(fauxToolCall("ls", { path: "." }), { stopReason: "toolUse" }),
			() => fauxAssistantMessage("目录已检查，权限未验证。"),
		]);
		await drain(
			fixture,
			fixture.application.events.start(session.id, { text: "检查点目标：检查目录\n约束：不要提交" }).runId,
		);
		const before = (await fixture.application.services.memoryState.checkpoint(session.id))!;
		await fixture.application.repositories.memoryState.saveCheckpoint(
			{ ...before, unresolvedQuestions: ["待验证权限"], version: before.version + 1 },
			before.version,
		);
		await fixture.restart();
		const manager = SessionManager.open(session.runtimeRef);
		manager.appendMessage({ role: "user", content: "旧资料 ".repeat(1500), timestamp: Date.now() });
		manager.appendMessage({
			...fauxAssistantMessage("最近资料 ".repeat(600)),
			provider: fixture.model.provider,
			model: fixture.model.id,
			api: fixture.model.api,
			usage: {
				input: 102399,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 102400,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		});
		fixture.faux.setResponses([
			(context) => {
				expect(JSON.stringify(context)).toContain("待验证权限");
				return fauxAssistantMessage("模型猜测所有权限问题已经完成。仍需以检查点为准。");
			},
			(context) => {
				const body = JSON.stringify(context.messages);
				expect(body).toContain("待验证权限");
				expect(body).toContain("不要提交");
				expect(body).toContain("ls:");
				return fauxAssistantMessage("继续验证权限。");
			},
		]);
		await drain(fixture, fixture.application.events.start(session.id, { text: "继续" }).runId);
		expect(
			SessionManager.open(session.runtimeRef)
				.getEntries()
				.some((entry) => entry.type === "compaction"),
		).toBe(true);
		const after = (await fixture.application.services.memoryState.checkpoint(session.id))!;
		expect(after.goal).toBe(before.goal);
		expect(after.completedSteps).toEqual(before.completedSteps);
		expect(after.unresolvedQuestions).toEqual(["待验证权限"]);
		expect(await readFile(session.runtimeRef, "utf8")).not.toContain("workbench-working-memory");
	} finally {
		await fixture.close();
	}
}, 30000);
