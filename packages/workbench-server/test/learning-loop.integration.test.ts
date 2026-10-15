import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Context } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import type { LearningReview } from "@earendil-works/workbench-core/contracts";
import { Type } from "typebox";
import { Parse } from "typebox/value";
import { expect, test, vi } from "vitest";
import { createAssistantFixture } from "./assistant-fixture.ts";
import {
	completeLearningTask,
	type LearningFixture,
	reviewOutput,
	similarityResponse,
} from "./project-learning-fixture.ts";

const Input = Type.Object({
	sources: Type.Array(
		Type.Object({ id: Type.String(), role: Type.String(), text: Type.String(), verified: Type.Boolean() }),
	),
	managedSkills: Type.Array(
		Type.Object({
			id: Type.String(),
			slug: Type.String(),
			hash: Type.String(),
			content: Type.String(),
			version: Type.Number(),
		}),
	),
});
function input(context: Context) {
	const message = context.messages.at(-1);
	if (message?.role !== "user") throw new Error("Review input missing");
	const text =
		typeof message.content === "string"
			? message.content
			: message.content
					.filter((part) => part.type === "text")
					.map((part) => part.text)
					.join("\n");
	return Parse(Input, JSON.parse(text));
}
async function settled(fixture: LearningFixture, projectId: string) {
	let review: LearningReview | undefined;
	await vi.waitFor(
		async () => {
			review = (await fixture.application.services.learning.list(projectId))[0];
			expect(review).toBeDefined();
			expect(["queued", "running"]).not.toContain(review!.status);
			expect(review!.changes.some((change) => ["pending", "applying"].includes(change.status))).toBe(false);
		},
		{ timeout: 15000 },
	);
	return review!;
}
async function drain(fixture: LearningFixture, runId: string) {
	for await (const entry of fixture.application.events.subscribe(runId))
		expect(entry.event.type).not.toBe("run.failed");
}

test("explicit workflow correction revises the same verified skill without adopting invented execution steps; rollback restores the version", async () => {
	const fixture = await createAssistantFixture();
	try {
		const project = await fixture.application.createProject({ name: "无工具纠正 中文" });
		const { session } = await completeLearningTask(fixture, project.id, "periodic");
		const first = await settled(fixture, project.id);
		const skillId = first.changes.find((change) => change.kind === "skill")!.skillId!;
		const original = await fixture.application.services.skills.readContent(skillId);
		const correction = "以后检查项目时，先展示文件数量，再展示目录名称。";
		const request = `${correction}本轮不要调用工具，也不要修改文件。`;
		fixture.faux.setResponses([
			fauxAssistantMessage("已收到流程纠正。"),
			(context) => {
				const data = input(context),
					skill = data.managedSkills[0],
					user = data.sources.find((source) => source.role === "user")!;
				expect(skill.content).toBe(original.content);
				fixture.faux.appendResponses([(context) => similarityResponse(context, "related")]);
				return fauxAssistantMessage(
					JSON.stringify({
						summary: "修订项目检查约束",
						memories: [],
						skills: [
							{
								slug: skill.slug,
								targetId: skill.id,
								baseHash: skill.hash,
								intent: "preference",
								patch: { oldText: "先展示目录名称，再展示文件数量。", newText: correction },
								title: "目录检查",
								description: "检查项目目录时使用",
								instructions: "模型虚构步骤：删除项目全部资料",
								evidence: [{ sourceId: user.id, quote: request }],
							},
						],
					}),
				);
			},
		]);
		const run = fixture.application.events.start(session.id, { text: request });
		await drain(fixture, run.runId);
		const review = await settled(fixture, project.id);
		expect(review.changes).toHaveLength(1);
		expect(review.changes[0].skillId).toBe(skillId);
		const changed = await fixture.application.services.skills.readContent(skillId);
		expect(changed.content).toContain(correction);
		expect(changed.content).toContain("1. 列出当前项目目录。");
		expect(changed.content).not.toContain("先展示目录名称，再展示文件数量。");
		expect(changed.content).toContain("核对工具返回的真实文件名；遵守会话权限。");
		expect(changed.content).not.toContain("删除项目全部资料");
		expect(changed.content).not.toContain("本轮不要调用工具");
		expect((await fixture.application.repositories.learning.skillStates(project.id))[0].version).toBe(2);
		await fixture.application.services.learning.resolve(review.id, review.changes[0].id, "rollback", review.version);
		expect((await fixture.application.services.skills.readContent(skillId)).content).toBe(original.content);
		await fixture.restart();
		expect((await fixture.application.repositories.learning.skillStates(project.id))[0]).toMatchObject({
			status: "managed",
			version: 3,
			contentHash: original.hash,
		});
	} finally {
		await fixture.close();
	}
});

test("failed native and PTC reads require linked later success; PTC outer success cannot validate a failed child", async () => {
	const fixture = await createAssistantFixture();
	try {
		const project = await fixture.application.createProject({ name: "恢复经验" });
		await fixture.application.services.learning.configure(project.id, {
			memoryInterval: 1,
			skillInterval: 0,
		});
		await writeFile(join(project.workspacePath, "有效 文件.txt"), "真实验证成功");
		const session = await fixture.application.createSession({ projectId: project.id });
		fixture.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("read", { path: "不存在.txt" }), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("read", { path: "有效 文件.txt" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("改正文件定位并读取成功。"),
			(context) => {
				const data = input(context),
					failed = data.sources.find((source) => source.role === "tool" && !source.verified)!;
				const output = reviewOutput(context);
				output.memories = [];
				output.skills[0].recoveredFailures = [{ sourceId: failed.id, quote: failed.text.slice(0, 100) }];
				return fauxAssistantMessage(JSON.stringify(output));
			},
		]);
		await drain(
			fixture,
			fixture.application.events.start(session.id, { text: "检查失败后纠正路径并读取有效文件" }).runId,
		);
		expect((await settled(fixture, project.id)).changes[0].status).toBe("applied");
		const ptc = await fixture.application.createSession({ projectId: project.id, profileSlug: "ptc" });
		fixture.faux.setResponses([
			fauxAssistantMessage(
				fauxToolCall("run_code", {
					code: 'try { await tools.read({path: "不存在.txt"}); } catch {} return await tools.read({path: "有效 文件.txt"});',
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("已读取有效原件。"),
			(context) => {
				const data = input(context);
				expect(data.sources.filter((source) => source.role === "tool").map((source) => source.verified)).toEqual([
					false,
					true,
				]);
				const output = reviewOutput(context);
				output.memories = [];
				output.skills[0].instructions += "\n失败后恢复读取，核对项目文件位置。";
				return fauxAssistantMessage(JSON.stringify(output));
			},
		]);
		await drain(fixture, fixture.application.events.start(ptc.id, { text: "读取项目资料并处理缺失文件" }).runId);
		const refused = await settled(fixture, project.id);
		expect(refused.changes).toEqual([]);
		expect(refused.diagnostics?.[0].message).toContain("失败恢复缺少");
	} finally {
		await fixture.close();
	}
});

test("actual native, read and PTC skill loads record hashes, survive restart and stay isolated from other sessions", async () => {
	const fixture = await createAssistantFixture();
	try {
		const project = await fixture.application.createProject({ name: "真实技能加载" });
		await completeLearningTask(fixture, project.id, "periodic");
		await settled(fixture, project.id);
		const skill = (await fixture.application.services.learning.reusableSkills(project.id))[0];
		await fixture.application.services.learning.configure(project.id, { memoryInterval: 0, skillInterval: 0 });
		const a = await fixture.application.createSession({ projectId: project.id });
		const b = await fixture.application.createSession({ projectId: project.id, profileSlug: "ptc" });
		fixture.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("read", { path: skill.path }), { stopReason: "toolUse" }),
			fauxAssistantMessage("已加载项目技能。"),
		]);
		const runA = Parse(
			Type.Object({ runId: Type.String() }),
			await (
				await fixture.request(`/sessions/${a.id}/messages`, {
					method: "POST",
					body: JSON.stringify({ text: "检查项目目录" }),
				})
			).json(),
		);
		await drain(fixture, runA.runId);
		fixture.faux.setResponses([
			fauxAssistantMessage(
				fauxToolCall("run_code", { code: `return await tools.read({path: ${JSON.stringify(skill.path)}});` }),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("PTC加载了项目技能。"),
		]);
		const runB = fixture.application.events.start(b.id, { text: "检查项目目录" });
		await drain(fixture, runB.runId);
		const uses = await fixture.application.repositories.learning.skillUses(project.id);
		expect(uses).toHaveLength(2);
		expect(new Set(uses.map((use) => use.sessionId)).size).toBe(2);
		expect(uses.every((use) => use.version === 1 && use.method === "read")).toBe(true);
		expect(uses.every((use) => use.validatedAt === undefined)).toBe(true);
		const actual = await fixture.application.repositories.memoryState.getContext(a.id);
		expect(actual?.loadedSkills?.[0].path).toBe(skill.path);
		await fixture.application.services.permissions.setMode(a.id, "full-access");
		fixture.faux.setResponses([
			fauxAssistantMessage(
				fauxToolCall(
					"verify_changes",
					{
						command:
							process.platform === "win32"
								? `if ((Get-Content -Raw -LiteralPath '${skill.path.replaceAll("'", "''")}') -notmatch '##') { exit 1 }; Write-Output verified; exit 0`
								: `test -s '${skill.path.replaceAll("'", "'\\''")}'`,
					},
					{ id: "skill-reuse-check" },
				),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(
				fauxToolCall("accept_changes", {
					criteria: [
						{
							requirement: "项目技能正文可用",
							checkIds: ["skill-reuse-check"],
							evidence: "实际读取完整技能正文并执行文件检查，命令成功退出",
						},
					],
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("按项目技能执行并通过验收。"),
		]);
		await drain(
			fixture,
			fixture.application.events.start(a.id, { text: "/skill:learned-inspect-project 检查目录" }).runId,
		);
		expect(
			(await fixture.application.repositories.learning.skillUses(project.id)).some(
				(use) => use.method === "invocation" && use.validatedAt !== undefined,
			),
		).toBe(true);
		await fixture.restart();
		expect((await fixture.application.services.sessions.get(a.id)).runtimeSessionId).toBe(a.runtimeSessionId);
		expect(await fixture.application.repositories.learning.skillUses(project.id)).toHaveLength(3);
		const unrelated = await fixture.application.createProject({ name: "隔离项目" });
		expect((await fixture.application.services.learning.experiences(unrelated.id)).skills).toEqual([]);
	} finally {
		await fixture.close();
	}
});

test("valid items survive invalid siblings and history is paged through Gateway", async () => {
	const fixture = await createAssistantFixture();
	try {
		const project = await fixture.application.createProject({ name: "逐项处理" });
		await completeLearningTask(fixture, project.id, "periodic", (context) => {
			const output = reviewOutput(context);
			return {
				...output,
				memories: [...output.memories, { text: "无效依据", evidence: [{ sourceId: "不存在", quote: "无效证据" }] }],
				checkpoint: { goal: 42 },
			};
		});
		const first = await settled(fixture, project.id);
		expect(first.changes).toHaveLength(2);
		expect(first.diagnostics).toHaveLength(2);
		expect(first.diagnostics?.find((item) => item.kind === "checkpoint")?.message).toContain("检查点结构无效");
		expect((await fixture.application.repositories.memoryState.getCheckpoint(first.sessionId))?.goal).toContain(
			"Python 3.12",
		);
		const page = await fixture.request(`/projects/${project.id}/learning?offset=20`);
		expect(await page.json()).toMatchObject({ reviews: [], total: 1 });
		const detail = await fixture.request(`/projects/${project.id}/learning/reviews/${first.id}`);
		expect(Parse(Type.Object({ sources: Type.Array(Type.Unknown()) }), await detail.json()).sources).toHaveLength(3);
		const other = await fixture.application.createProject({ name: "不能访问" });
		expect((await fixture.request(`/projects/${other.id}/learning/reviews/${first.id}`)).status).toBe(403);
		expect(await readFile(project.memoryFilePath, "utf8")).toContain("Python 3.12");
	} finally {
		await fixture.close();
	}
});

test("review refuses to rewrite a managed skill omitted from its complete-body budget", async () => {
	const fixture = await createAssistantFixture();
	try {
		const project = await fixture.application.createProject({ name: "完整正文预算" });
		await completeLearningTask(fixture, project.id, "periodic", (context) => {
			const output = reviewOutput(context);
			output.memories = [];
			fixture.faux.appendResponses([
				() =>
					fauxAssistantMessage(JSON.stringify({ relation: "distinct", reason: "alpha 与 beta 的适用目标不同。" })),
			]);
			output.skills = ["alpha", "beta"].map((suffix) => ({
				...output.skills[0],
				slug: `learned-budget-${suffix}`,
				title: `流程 ${suffix}`,
				description: `检查 ${suffix} 流程时使用`,
				instructions: `${output.skills[0].instructions}\n${"具备完整适用条件及核验步骤。".repeat(650)}`.slice(
					0,
					8000,
				),
			}));
			return output;
		});
		await settled(fixture, project.id);
		const originals = await Promise.all(
			(await fixture.application.services.learning.reusableSkills(project.id)).map(async (skill) => ({
				skill,
				body: await fixture.application.services.skills.readContent(skill.id),
			})),
		);
		expect(originals).toHaveLength(2);
		await completeLearningTask(fixture, project.id, "periodic", (context) => {
			const provided = input(context).managedSkills;
			expect(provided).toHaveLength(1);
			const omitted = originals.find((item) => !provided.some((value) => value.id === item.skill.id))!;
			const output = reviewOutput(context);
			output.memories = [];
			output.skills = [
				{
					...output.skills[0],
					slug: omitted.skill.slug,
					targetId: omitted.skill.id,
					baseHash: omitted.body.hash,
					instructions: "不能依据未提供的正文重写整个技能。",
				},
			];
			return output;
		});
		const review = await settled(fixture, project.id);
		expect(review.changes).toEqual([]);
		expect(review.diagnostics?.[0].message).toContain("完整正文预算");
		for (const item of originals)
			expect((await fixture.application.services.skills.readContent(item.skill.id)).content).toBe(item.body.content);
	} finally {
		await fixture.close();
	}
});

test("a missing skill guessed under the source project gives the scoped native location and records only the recovered full read", async () => {
	const fixture = await createAssistantFixture();
	try {
		const sourcePath = join(fixture.root, "源项目 中文 空格");
		await mkdir(sourcePath);
		const project = await fixture.application.createProject({ sourcePath });
		await completeLearningTask(fixture, project.id, "periodic");
		await settled(fixture, project.id);
		const skill = (await fixture.application.services.learning.reusableSkills(project.id))[0];
		await fixture.application.services.learning.configure(project.id, { memoryInterval: 0, skillInterval: 0 });
		const session = await fixture.application.createSession({ projectId: project.id });
		const guessed = join(sourcePath, "skills", skill.slug, "SKILL.md");
		expect(guessed).not.toBe(skill.path);
		let catalog = "",
			missingResult = "",
			readFailed = false;
		fixture.faux.setResponses([
			(context) => {
				catalog = context.systemPrompt ?? "";
				return fauxAssistantMessage(fauxToolCall("read", { path: guessed }), { stopReason: "toolUse" });
			},
			(context) => {
				const result = context.messages.at(-1);
				expect(result?.role).toBe("toolResult");
				if (result?.role !== "toolResult") throw new Error("Expected missing skill read");
				readFailed = result.isError;
				missingResult = result.content
					.filter((part) => part.type === "text")
					.map((part) => part.text)
					.join("\n");
				return fauxAssistantMessage(fauxToolCall("read", { path: skill.path }), { stopReason: "toolUse" });
			},
			fauxAssistantMessage("已依据实际技能正文继续。"),
		]);
		const response = await fixture.request(`/sessions/${session.id}/messages`, {
			method: "POST",
			body: JSON.stringify({ text: "按本项目已有流程检查目录" }),
		});
		expect(response.status).toBe(202);
		const run = Parse(Type.Object({ runId: Type.String() }), await response.json());
		for await (const entry of fixture.application.events.subscribe(run.runId)) {
			if (entry.event.type === "permission.requested") {
				expect(String(entry.event.data.summary)).toContain(skill.path);
				await fixture.application.services.permissions.resolve(String(entry.event.data.approvalId), "approved");
			}
			expect(entry.event.type).not.toBe("run.failed");
		}
		expect(catalog).toContain(skill.path);
		expect(readFailed).toBe(true);
		expect(missingResult).toContain("当前会话已启用的同名技能实际位置");
		expect(missingResult).toContain(skill.path);
		const uses = await fixture.application.repositories.learning.skillUses(project.id);
		expect(uses).toHaveLength(1);
		expect(uses[0]).toMatchObject({ sessionId: session.id, version: 1, method: "read" });
		const actual = await fixture.application.repositories.memoryState.getContext(session.id);
		expect(actual?.loadedSkills?.[0].path).toBe(skill.path);
		const unrelated = await fixture.application.createProject({ name: "无经验项目" });
		const other = await fixture.application.createSession({ projectId: unrelated.id });
		fixture.faux.setResponses([
			fauxAssistantMessage(
				fauxToolCall("read", { path: join(unrelated.workspacePath, "skills", skill.slug, "SKILL.md") }),
				{ stopReason: "toolUse" },
			),
			(context) => {
				expect(JSON.stringify(context.messages.at(-1))).not.toContain(skill.path);
				return fauxAssistantMessage("当前项目没有该技能。 ");
			},
		]);
		await drain(fixture, fixture.application.events.start(other.id, { text: "检查项目技能" }).runId);
		expect(await fixture.application.repositories.learning.skillUses(unrelated.id)).toEqual([]);
	} finally {
		await fixture.close();
	}
});
