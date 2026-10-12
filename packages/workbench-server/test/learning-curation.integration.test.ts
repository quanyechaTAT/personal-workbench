import { readFile } from "node:fs/promises";
import type { Context } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import type { LearningReview } from "@earendil-works/workbench-core/contracts";
import { Type } from "typebox";
import { Parse } from "typebox/value";
import { expect, test, vi } from "vitest";
import { applyPreferencePatch } from "../../workbench-core/src/learning-curation.ts";
import { createAssistantFixture } from "./assistant-fixture.ts";
import { LEARNED_INSTRUCTIONS, type LearningFixture } from "./project-learning-fixture.ts";

const ContextResult = Type.Object({
	sources: Type.Array(
		Type.Object({ id: Type.String(), role: Type.String(), text: Type.String(), verified: Type.Boolean() }),
	),
	skills: Type.Array(Type.Object({ id: Type.String(), slug: Type.String() })),
});
function toolText(context: Context): string {
	const message = context.messages.at(-1);
	if (message?.role !== "toolResult") throw new Error("Expected a real Pi tool result");
	return message.content
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}
function reviewSources(context: Context) {
	const message = context.messages.at(-1);
	if (message?.role !== "user") throw new Error("Expected review input");
	const text =
		typeof message.content === "string"
			? message.content
			: message.content
					.filter((part) => part.type === "text")
					.map((part) => part.text)
					.join("\n");
	return Parse(ContextResult, { ...JSON.parse(text), skills: [] }).sources;
}
async function message(fixture: LearningFixture, sessionId: string, text: string) {
	const response = await fixture.request(`/sessions/${sessionId}/messages`, {
		method: "POST",
		body: JSON.stringify({ text }),
	});
	expect(response.status).toBe(202);
	const run = Parse(Type.Object({ runId: Type.String() }), await response.json());
	const stream = await (await fixture.request(`/runs/${run.runId}/events`)).text();
	expect(stream).toContain('"type":"run.completed"');
	expect(stream).not.toContain('"type":"run.failed"');
	return run.runId;
}
async function finished(fixture: LearningFixture, projectId: string): Promise<LearningReview> {
	let review: LearningReview | undefined;
	await vi.waitFor(
		async () => {
			review = (await fixture.application.services.learning.list(projectId))[0];
			expect(review).toBeDefined();
			expect(["queued", "running"]).not.toContain(review!.status);
		},
		{ timeout: 15000 },
	);
	return review!;
}

test("default periodic counters stay isolated and survive restart without a review after every reply", async () => {
	const fixture = await createAssistantFixture();
	try {
		const project = await fixture.application.createProject({ name: "周期学习 中文 空格" });
		await fixture.application.services.learning.configure(project.id, { memoryInterval: 10, skillInterval: 10 });
		expect(await fixture.application.services.learning.settings(project.id)).toMatchObject({
			memoryInterval: 10,
			skillInterval: 10,
		});
		const a = await fixture.application.createSession({ projectId: project.id });
		const b = await fixture.application.createSession({ projectId: project.id });
		for (const session of [a, b])
			for (let index = 0; index < 4; index++) {
				fixture.faux.setResponses([fauxAssistantMessage("收到，没有新的重要知识。")]);
				await message(fixture, session.id, `普通问答 ${index}`);
			}
		expect(await fixture.application.services.learning.list(project.id)).toEqual([]);
		expect((await fixture.application.services.learning.schedule(project.id)).map((value) => value.turns)).toEqual([
			4, 4,
		]);
		await fixture.restart();
		expect((await fixture.application.services.sessions.get(a.id)).runtimeSessionId).toBe(a.runtimeSessionId);
		fixture.faux.setResponses([fauxAssistantMessage("继续原任务。")]);
		await message(fixture, a.id, "继续");
		expect(
			(await fixture.application.services.learning.schedule(project.id)).find((value) => value.sessionId === a.id)
				?.turns,
		).toBe(5);
		expect(await fixture.application.services.learning.list(project.id)).toEqual([]);
		expect(fixture.faux.getPendingResponseCount()).toBe(0);
	} finally {
		await fixture.close();
	}
});

test("periodic review extracts a durable environment from multiple tasks; valid empty review is normal", async () => {
	const fixture = await createAssistantFixture();
	try {
		const project = await fixture.application.createProject({ name: "跨任务提炼" });
		await fixture.application.services.learning.configure(project.id, {
			memoryInterval: 3,
			skillInterval: 0,
		});
		const session = await fixture.application.createSession({ projectId: project.id });
		const fact = "项目运行环境是 Python 3.12。";
		const initialRuns: string[] = [];
		for (const text of [fact, "这个任务的临时总数是15，不是长期事实。"]) {
			fixture.faux.setResponses([fauxAssistantMessage("收到。")]);
			initialRuns.push(await message(fixture, session.id, text));
		}
		expect(await fixture.application.services.learning.list(project.id)).toEqual([]);
		fixture.faux.setResponses([
			fauxAssistantMessage("第三个任务已完成。"),
			(context) => {
				expect(context.tools).toHaveLength(0);
				const sources = reviewSources(context);
				expect(sources.filter((source) => source.role === "user")).toHaveLength(3);
				const source = sources.find((source) => source.text === fact)!;
				return fauxAssistantMessage(
					JSON.stringify({
						summary: "提取环境，忽略临时任务数据",
						memories: [
							{
								text: fact,
								category: "environment",
								futureUse: "后续开发选择正确版本的 Python 执行环境",
								evidence: [{ sourceId: source.id, quote: fact }],
							},
						],
						skills: [],
					}),
				);
			},
		]);
		const runId = await message(fixture, session.id, "第三个任务，仅确认收到");
		const review = await finished(fixture, project.id);
		expect(review).toMatchObject({ origin: "periodic", sourceRunId: runId, status: "ready" });
		expect(review.sourceRunIds).toHaveLength(3);
		await vi.waitFor(async () =>
			expect((await fixture.application.services.learning.get(review.id)).changes[0].status).toBe("applied"),
		);
		expect(await readFile(project.memoryFilePath, "utf8")).toContain(fact);
		expect(await readFile(project.memoryFilePath, "utf8")).not.toContain("总数是15");
		const savedReview = await fixture.application.services.learning.get(review.id);
		expect(savedReview.changes[0].verifiedRunIds).toEqual([initialRuns[0]]);
		const savedFact = (await fixture.application.services.semantic.list({ project }))[0];
		expect(savedFact.evidence).toMatchObject([{ runId: initialRuns[0], excerpt: fact }]);
		expect(savedFact.evidence[0].runId).not.toBe(runId);
		await fixture.restart();
		expect((await fixture.application.services.semantic.list({ project }))[0].evidence[0].runId).toBe(initialRuns[0]);
		expect(
			(await fixture.application.services.learning.detail(review.id)).sources.filter(
				(source) => source.role === "user",
			),
		).toHaveLength(3);
		await fixture.application.services.learning.configure(project.id, {
			memoryInterval: 1,
		});
		fixture.faux.setResponses([
			fauxAssistantMessage("没有重要变化。"),
			fauxAssistantMessage(JSON.stringify({ summary: "没有重要新经验", memories: [], skills: [] })),
		]);
		await message(fixture, session.id, "问候");
		expect((await finished(fixture, project.id)).status).toBe("empty");
		expect(await fixture.application.services.semantic.list({ project })).toHaveLength(1);
	} finally {
		await fixture.close();
	}
});

test("consuming a bounded cadence window clears dropped counters and preserves newer arrivals", async () => {
	const fixture = await createAssistantFixture();
	try {
		const project = await fixture.application.createProject({ name: "有界周期恢复" });
		const session = await fixture.application.createSession({ projectId: project.id });
		const repository = fixture.application.repositories.learning;
		for (let index = 0; index < 70; index++)
			await repository.advanceCadence(
				session.id,
				project.id,
				{
					id: `reference-${index}`,
					startedAt: "2026-10-10T00:00:00Z",
					settledAt: "2026-10-10T00:00:01Z",
					verified: true,
					iterations: 2,
				},
				2,
			);
		const window = (await repository.cadences(project.id))[0];
		expect(window.turns).toBe(70);
		expect(window.runs).toHaveLength(64);
		await repository.advanceCadence(
			session.id,
			project.id,
			{
				id: "new-arrival",
				startedAt: "2026-10-10T00:01:00Z",
				settledAt: "2026-10-10T00:01:01Z",
				verified: true,
				iterations: 3,
			},
			3,
		);
		await repository.consumeCadence(
			session.id,
			window.runs.map((run) => run.id),
		);
		expect((await repository.cadences(project.id))[0]).toMatchObject({
			turns: 1,
			iterations: 3,
			runs: [{ id: "new-arrival" }],
		});
		expect(await repository.advanceCadence(session.id, project.id, window.runs[0], 2)).toBeUndefined();
		await repository.consumeCadence(session.id, ["new-arrival"]);
		await fixture.restart();
		expect((await fixture.application.repositories.learning.cadences(project.id))[0]).toMatchObject({
			turns: 0,
			iterations: 0,
			runs: [],
		});
	} finally {
		await fixture.close();
	}
});

test("main Agent proactively saves an important fact through real Pi tools without an extra model request", async () => {
	const fixture = await createAssistantFixture();
	try {
		const project = await fixture.application.createProject({ name: "主动事实" });
		await fixture.application.services.learning.configure(project.id);
		const session = await fixture.application.createSession({ projectId: project.id });
		const fact = "项目统一使用 UTF-8 编码。";
		fixture.faux.setResponses([
			(context) => {
				expect(context.tools?.map((tool) => tool.name)).toContain("learning_context");
				return fauxAssistantMessage(fauxToolCall("learning_context", {}), { stopReason: "toolUse" });
			},
			(context) => {
				const input = Parse(ContextResult, JSON.parse(toolText(context)));
				const user = input.sources.find((source) => source.role === "user")!;
				return fauxAssistantMessage(
					fauxToolCall("memory_propose", {
						kind: "project",
						proposedText: fact,
						reason: "稳定编码约束",
						category: "environment",
						futureUse: "后续文件读写和导出统一选择正确的文本编码",
						evidence: [{ sourceId: user.id, quote: fact }],
					}),
					{ stopReason: "toolUse" },
				);
			},
			(context) => {
				expect(toolText(context)).toContain('"status": "applied"');
				return fauxAssistantMessage("后续按 UTF-8 处理。");
			},
		]);
		await message(fixture, session.id, `以后所有文件按这一环境约束：${fact}`);
		const review = (await fixture.application.services.learning.list(project.id))[0];
		expect(review.origin).toBe("agent");
		expect(review.usage).toBeUndefined();
		expect(await readFile(project.memoryFilePath, "utf8")).toContain(fact);
		expect(fixture.faux.getPendingResponseCount()).toBe(0);
		const sources = (await fixture.application.services.learning.detail(review.id)).sources;
		expect(sources.some((source) => ["learning_context", "memory_propose"].includes(source.toolName ?? ""))).toBe(
			false,
		);
		const history = await fixture.application.services.sessions.readTranscript(session.id);
		expect(history.filter((source) => source.role === "user")).toHaveLength(1);
	} finally {
		await fixture.close();
	}
});

test("main Agent creates a class procedure then replaces one preference in place on the same skill", async () => {
	const fixture = await createAssistantFixture();
	try {
		// Output rules may live in a Steps section, and the patch may target only its ordering fragment.
		const classInstructions = LEARNED_INSTRUCTIONS.replace(
			"## 输出\n先展示目录名称，再展示文件数量。",
			"3. 输出检查报告，先展示目录名称，再展示文件数量。",
		);
		const project = await fixture.application.createProject({ name: "主动流程" });
		await fixture.application.services.learning.configure(project.id, {
			memoryInterval: 0,
			skillInterval: 0,
		});
		const session = await fixture.application.createSession({ projectId: project.id });
		fixture.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("ls", { path: "." }), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("learning_context", {}), { stopReason: "toolUse" }),
			(context) => {
				const input = Parse(ContextResult, JSON.parse(toolText(context)));
				const tool = input.sources.find((source) => source.role === "tool" && source.verified)!;
				return fauxAssistantMessage(
					fauxToolCall("skill_manage", {
						action: "save",
						skill: {
							slug: "learned-inspect-project",
							title: "项目目录检查",
							description: "检查任意项目目录时使用",
							instructions: classInstructions,
							evidence: [{ sourceId: tool.id, quote: tool.text.slice(0, 100) }],
						},
					}),
					{ stopReason: "toolUse" },
				);
			},
			(context) => {
				expect(toolText(context)).toContain('"status": "applied"');
				return fauxAssistantMessage("目录检查完成。");
			},
		]);
		await message(fixture, session.id, "检查项目目录，并提炼未来同类任务的方法");
		const skill = (await fixture.application.services.learning.reusableSkills(project.id))[0];
		expect(skill).toBeDefined();
		const old = await fixture.application.services.skills.readContent(skill.id);
		const correction = "以后先显示文件数量，再显示目录名称。";
		fixture.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("skill_manage", { action: "view", skillId: skill.id }), {
				stopReason: "toolUse",
			}),
			(context) => {
				expect(toolText(context)).toContain(old.hash);
				return fauxAssistantMessage(fauxToolCall("learning_context", {}), { stopReason: "toolUse" });
			},
			(context) => {
				const user = Parse(ContextResult, JSON.parse(toolText(context))).sources.find(
					(source) => source.role === "user",
				)!;
				return fauxAssistantMessage(
					fauxToolCall("skill_manage", {
						action: "save",
						skill: {
							slug: skill.slug,
							title: "项目目录检查",
							description: skill.description,
							instructions: "不能采用虚构的删除操作",
							targetId: skill.id,
							baseHash: old.hash,
							intent: "preference",
							patch: { oldText: "先展示目录名称，再展示文件数量。", newText: correction },
							evidence: [{ sourceId: user.id, quote: correction }],
						},
					}),
					{ stopReason: "toolUse" },
				);
			},
			(context) => {
				expect(toolText(context)).toContain('"status": "applied"');
				return fauxAssistantMessage("后续按新顺序处理。");
			},
		]);
		await message(fixture, session.id, correction);
		const current = await fixture.application.services.skills.readContent(skill.id);
		expect(current.content).toContain(correction);
		expect(current.content).not.toContain("先展示目录名称，再展示文件数量。");
		expect(current.content).toContain("核对工具返回的真实文件名；遵守会话权限。");
		expect(current.content).not.toContain("虚构的删除操作");
		expect(current.content).not.toContain("## 用户流程约束");
		expect(current.content).toContain("1. 列出当前项目目录。");
		expect(await fixture.application.services.learning.reusableSkills(project.id)).toHaveLength(1);
		expect((await fixture.application.repositories.learning.skillStates(project.id))[0].version).toBe(2);
		const review = (await fixture.application.services.learning.list(project.id))[0];
		await fixture.application.services.learning.resolve(review.id, review.changes[0].id, "rollback", review.version);
		await fixture.restart();
		expect((await fixture.application.services.skills.readContent(skill.id)).content).toBe(old.content);
	} finally {
		await fixture.close();
	}
});

test("supported quotes still cannot promote a task recap or session narrative into facts or skills", async () => {
	const fixture = await createAssistantFixture();
	try {
		const project = await fixture.application.createProject({ name: "经验内容边界" });
		await fixture.application.services.learning.configure(project.id, {
			memoryInterval: 1,
			skillInterval: 0,
		});
		const session = await fixture.application.createSession({ projectId: project.id });
		const before = await readFile(project.memoryFilePath, "utf8");
		fixture.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("ls", { path: "." }), { stopReason: "toolUse" }),
			fauxAssistantMessage("已完成一次目录任务。"),
			(context) => {
				const sources = reviewSources(context);
				const user = sources.find((source) => source.role === "user")!,
					tool = sources.find((source) => source.role === "tool")!;
				return fauxAssistantMessage(
					JSON.stringify({
						summary: "错误地把任务结果当经验",
						memories: [
							{
								text: "已生成报告，总计15。",
								category: "fact",
								futureUse: "以后复用本次报告的固定结果和统计数值",
								evidence: [{ sourceId: user.id, quote: "已生成报告，总计15。" }],
							},
						],
						skills: [
							{
								slug: "learned-session-recap",
								title: "会话回顾",
								description: "回顾今天任务",
								instructions: `${LEARNED_INSTRUCTIONS}\n本轮会话已输出目录，这是任务执行记录。`,
								evidence: [{ sourceId: tool.id, quote: tool.text.slice(0, 100) }],
							},
						],
					}),
				);
			},
		]);
		await message(fixture, session.id, "已生成报告，总计15。检查目录");
		const review = await finished(fixture, project.id);
		expect(review.changes).toEqual([]);
		expect(review.diagnostics).toHaveLength(2);
		expect(await readFile(project.memoryFilePath, "utf8")).toBe(before);
		expect(await fixture.application.services.learning.reusableSkills(project.id)).toEqual([]);
		expect(await fixture.application.repositories.memoryState.getRunEpisode(review.sourceRunId!)).toBeDefined();
	} finally {
		await fixture.close();
	}
});

test("unrelated failed discovery cannot veto an independently verified procedure, while invented recovery is rejected", async () => {
	const fixture = await createAssistantFixture();
	try {
		const project = await fixture.application.createProject({ name: "无关失败边界" });
		await fixture.application.services.learning.configure(project.id, {
			memoryInterval: 1,
			skillInterval: 0,
		});
		const session = await fixture.application.createSession({ projectId: project.id });
		fixture.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("read", { path: "无关说明不存在.txt" }), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("ls", { path: "." }), { stopReason: "toolUse" }),
			fauxAssistantMessage("独立核对目录成功。"),
			(context) => {
				const sources = reviewSources(context),
					tool = sources.find((source) => source.role === "tool" && source.verified)!;
				return fauxAssistantMessage(
					JSON.stringify({
						summary: "保留目录方法，不声称修复缺失说明",
						memories: [],
						skills: [
							{
								slug: "learned-independent-inspect",
								title: "目录核对",
								description: "列出和核对项目目录",
								instructions: LEARNED_INSTRUCTIONS.replace("## 适用条件", "适用条件：")
									.replace("## 步骤", "步骤：")
									.replace("## 验证", "验证："),
								evidence: [{ sourceId: tool.id, quote: tool.text.slice(0, 100) }],
							},
						],
					}),
				);
			},
		]);
		await message(fixture, session.id, "尝试读取说明；即使说明缺失，也独立核对目录");
		const review = await finished(fixture, project.id);
		await vi.waitFor(async () =>
			expect((await fixture.application.services.learning.get(review.id)).changes[0].status).toBe("applied"),
		);
		expect(review.diagnostics).toEqual([]);
		const actual = (await fixture.application.services.learning.reusableSkills(project.id))[0];
		expect((await fixture.application.services.skills.readContent(actual.id)).content).not.toContain(
			"无关说明不存在",
		);
	} finally {
		await fixture.close();
	}
	// User output preferences may not remove successful verification requirements.
	expect(() =>
		applyPreferencePatch(LEARNED_INSTRUCTIONS, {
			oldText: "核对工具返回的真实文件名；遵守会话权限。",
			newText: "以后只给出一个结论。",
		}),
	).toThrow("执行和验证步骤");
	expect(() =>
		applyPreferencePatch("## 步骤\n2. 用程序计算总数，不引用报告中的既有数字作为计算依据。", {
			oldText: "不引用报告中的既有数字作为计算依据。",
			newText: "以后直接沿用报告数字。",
		}),
	).toThrow("执行和验证步骤");
});

test("a reporting clause in a mixed step can be corrected without changing computation or verification", () => {
	const content =
		"## 步骤\n5. 汇总所有数量，并按“商品明细”后“总数”的顺序输出核验结果。\n## 验证\n核对总和及文件未改变。";
	expect(
		applyPreferencePatch(content, {
			oldText: "按“商品明细”后“总数”的顺序输出核验结果",
			newText: "先列总数，再列商品明细",
		}),
	).toBe("## 步骤\n5. 汇总所有数量，并先列总数，再列商品明细。\n## 验证\n核对总和及文件未改变。");
	expect(() =>
		applyPreferencePatch(content, {
			oldText: "汇总所有数量，并按“商品明细”后“总数”的顺序输出核验结果",
			newText: "直接引用旧报告",
		}),
	).toThrow("执行和验证步骤");
	expect(() =>
		applyPreferencePatch(content, {
			oldText: "汇总所有数量",
			newText: "直接使用既有数字",
		}),
	).toThrow("执行和验证步骤");
});
