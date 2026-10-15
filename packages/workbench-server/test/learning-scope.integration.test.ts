import { readFile } from "node:fs/promises";
import type { Context } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import type { LearningReview } from "@earendil-works/workbench-core/contracts";
import { Type } from "typebox";
import { Parse } from "typebox/value";
import { expect, test, vi } from "vitest";
import { createAssistantFixture } from "./assistant-fixture.ts";
import { similarityResponse } from "./project-learning-fixture.ts";

const Sources = Type.Object({
	sources: Type.Array(Type.Object({ id: Type.String(), role: Type.String(), text: Type.String() })),
});
function input(context: Context) {
	const message = context.messages.at(-1)!;
	const content =
		typeof message.content === "string"
			? message.content
			: message.content
					.filter((part) => part.type === "text")
					.map((part) => part.text)
					.join("\n");
	return Parse(Sources, JSON.parse(content));
}
async function send(fixture: Awaited<ReturnType<typeof createAssistantFixture>>, sessionId: string, text: string) {
	const response = await fixture.request(`/sessions/${sessionId}/messages`, {
		method: "POST",
		body: JSON.stringify({ text }),
	});
	expect(response.status).toBe(202);
	const { runId } = Parse(Type.Object({ runId: Type.String() }), await response.json());
	expect(await (await fixture.request(`/runs/${runId}/events`)).text()).toContain('"type":"run.completed"');
}
async function settled(fixture: Awaited<ReturnType<typeof createAssistantFixture>>, projectId: string) {
	let review: LearningReview | undefined;
	await vi.waitFor(
		async () => {
			review = (await fixture.application.services.learning.list(projectId))[0];
			expect(review && !["running", "queued"].includes(review.status)).toBe(true);
			expect(review?.changes.every((change) => change.status !== "pending" && change.status !== "applying")).toBe(
				true,
			);
		},
		{ timeout: 15000 },
	);
	return review!;
}

test("periodic and prompt review route preferences to USER.md and environments to project AGENTS.md; both survive restart", async () => {
	const fixture = await createAssistantFixture();
	try {
		const project = await fixture.application.createProject({ name: "偏好与环境 中文" });
		const other = await fixture.application.createProject({ name: "另一个项目" });
		await fixture.application.services.learning.configure(project.id, { memoryInterval: 1, skillInterval: 0 });
		const session = await fixture.application.createSession({ projectId: project.id });
		const preference = "用户偏好先给结论，再给必要步骤。",
			environment = "项目脚本统一使用 Python 3.12。";
		fixture.faux.setResponses([
			fauxAssistantMessage("收到。"),
			(context) => {
				expect(context.tools).toHaveLength(0);
				const user = input(context).sources.find((source) => source.role === "user")!;
				return fauxAssistantMessage(
					JSON.stringify({
						summary: "分范围保存长期知识",
						memories: [
							{
								text: preference,
								category: "preference",
								futureUse: "今后所有项目按用户喜欢的顺序交流",
								evidence: [{ sourceId: user.id, quote: preference }],
							},
							{
								text: environment,
								category: "environment",
								futureUse: "后续选择正确的项目脚本运行环境",
								evidence: [{ sourceId: user.id, quote: environment }],
							},
						],
						skills: [],
					}),
				);
			},
		]);
		await send(fixture, session.id, `长期约定：${preference}\n${environment}`);
		const review = await settled(fixture, project.id);
		expect(review.origin).toBe("periodic");
		expect(review.changes.map((change) => change.relativePath)).toEqual([
			"USER.md",
			`projects/${project.slug}/AGENTS.md`,
		]);
		const userPath = fixture.application.paths.userMemory;
		expect(await readFile(userPath, "utf8")).toContain(preference);
		expect(await readFile(userPath, "utf8")).not.toContain(environment);
		expect(await readFile(project.memoryFilePath, "utf8")).toContain(environment);
		expect(await readFile(project.memoryFilePath, "utf8")).not.toContain(preference);
		const fact = (await fixture.application.services.semantic.list({ project })).find(
			(fact) => fact.text === preference,
		)!;
		expect(fact).toMatchObject({ kind: "user", relativePath: "USER.md", confirmation: "user_confirmed" });
		expect(fact.projectId).toBeUndefined();
		expect(fact.evidence[0]).toMatchObject({ sessionId: session.id, excerpt: preference });
		await fixture.restart();
		const otherSession = await fixture.application.createSession({ projectId: other.id });
		const context = await fixture.application.contextForSession(otherSession.id, "用户偏好，怎么展示结论和步骤？");
		expect(JSON.stringify(context)).toContain(preference);
		expect(JSON.stringify(context)).not.toContain(environment);
		expect((await fixture.application.services.sessions.get(session.id)).runtimeSessionId).toBe(
			session.runtimeSessionId,
		);
		const replacement = "用户偏好先给必要步骤，再给结论。";
		fixture.faux.setResponses([
			fauxAssistantMessage("按新顺序。"),
			(context) => {
				expect(context.tools).toHaveLength(0);
				const user = input(context).sources.find((source) => source.text.includes(replacement))!;
				fixture.faux.appendResponses([(context) => similarityResponse(context, "related")]);
				return fauxAssistantMessage(
					JSON.stringify({
						summary: "用户更正长期偏好",
						memories: [
							{
								text: replacement,
								category: "preference",
								futureUse: "以后所有项目遵循用户更正的交流顺序",
								change: { operation: "supersede", targetId: fact.id, expectedVersion: fact.version },
								evidence: [{ sourceId: user.id, quote: replacement }],
							},
						],
						skills: [],
					}),
				);
			},
		]);
		await send(fixture, otherSession.id, `长期更正：${replacement} 总结这次任务。`);
		expect((await settled(fixture, other.id)).origin).toBe("prompt");
		const current = await fixture.application.services.semantic.list({ project });
		expect(current.some((value) => value.text === replacement)).toBe(true);
		expect(current.some((value) => value.text === preference)).toBe(false);
		const correction = (await fixture.application.services.learning.list(other.id))[0];
		await fixture.application.services.learning.resolve(
			correction.id,
			correction.changes[0].id,
			"rollback",
			correction.version,
		);
		expect(
			(await fixture.application.services.semantic.list({ project })).some((value) => value.text === preference),
		).toBe(true);
	} finally {
		await fixture.close();
	}
});

test("foreground memory_propose applies user preferences with evidence even when the Agent requests project scope", async () => {
	const fixture = await createAssistantFixture();
	try {
		const project = await fixture.application.createProject({ name: "主动学习范围" });
		const session = await fixture.application.createSession({ projectId: project.id });
		const preference = "以后使用简短中文回答，不要加寒暄。";
		fixture.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("learning_context", {}), { stopReason: "toolUse" }),
			(context) => {
				const user = input(context).sources.find((source) => source.role === "user")!;
				return fauxAssistantMessage(
					fauxToolCall("memory_propose", {
						kind: "project",
						proposedText: preference,
						reason: "长期交互要求",
						category: "preference",
						futureUse: "后续其他项目和会话都采用用户期望的表达方式",
						evidence: [{ sourceId: user.id, quote: preference }],
					}),
					{ stopReason: "toolUse" },
				);
			},
			(context) => {
				expect(JSON.stringify(context.messages.at(-1))).toContain("applied");
				return fauxAssistantMessage("收到。");
			},
		]);
		await send(fixture, session.id, preference);
		const review = (await fixture.application.services.learning.list(project.id))[0];
		expect(review).toMatchObject({ origin: "agent", changes: [{ relativePath: "USER.md", status: "applied" }] });
		expect(await readFile(project.memoryFilePath, "utf8")).not.toContain(preference);
		expect(fixture.faux.getPendingResponseCount()).toBe(0);
	} finally {
		await fixture.close();
	}
});

test("temporary requirements cannot become Workbench preferences; a target in another file cannot be replaced", async () => {
	const fixture = await createAssistantFixture();
	try {
		const project = await fixture.application.createProject({ name: "临时要求范围" });
		const old = await fixture.application.services.memory.propose(
			{ project },
			{ kind: "project", proposedText: "项目工具必须离线运行。", reason: "项目约束" },
		);
		await fixture.application.services.memory.accept(old.id);
		const fact = (await fixture.application.services.semantic.list({ project }))[0];
		const session = await fixture.application.createSession({ projectId: project.id });
		const before = await readFile(fixture.application.paths.userMemory, "utf8");
		fixture.faux.setResponses([
			fauxAssistantMessage("收到。"),
			(context) => {
				const user = input(context).sources.find((source) => source.role === "user")!;
				return fauxAssistantMessage(
					JSON.stringify({
						summary: "拒绝不当晋升",
						memories: [
							{
								text: "用户习惯简短回答。",
								category: "preference",
								futureUse: "以后所有会话保持简短回答",
								evidence: [{ sourceId: user.id, quote: "本次任务只用简短回答。" }],
							},
							{
								text: "以后使用分点回答。",
								category: "preference",
								futureUse: "以后所有项目使用用户明确的表达偏好",
								change: { operation: "supersede", targetId: fact.id, expectedVersion: fact.version },
								evidence: [{ sourceId: user.id, quote: "以后使用分点回答。" }],
							},
						],
						skills: [],
					}),
				);
			},
		]);
		await send(fixture, session.id, "本次任务只用简短回答。以后使用分点回答。总结这次任务");
		const review = await settled(fixture, project.id);
		expect(review.changes).toEqual([]);
		expect(review.diagnostics).toHaveLength(2);
		expect(review.diagnostics?.map((value) => value.message).join(" ")).toContain("长期依据");
		expect(await readFile(fixture.application.paths.userMemory, "utf8")).toBe(before);
		expect((await fixture.application.services.semantic.list({ project }))[0].id).toBe(fact.id);
	} finally {
		await fixture.close();
	}
});

test("rejected foreground evidence is a real Pi tool error with scope and correction guidance; the same fact can be corrected without repeating a saved preference", async () => {
	const fixture = await createAssistantFixture();
	try {
		const project = await fixture.application.createProject({ name: "证据拒绝反馈" });
		const session = await fixture.application.createSession({ projectId: project.id });
		const preference = "以后先给结论，再给必要步骤。";
		const fact = "项目工具必须离线运行";
		let sourceId = "";
		fixture.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("learning_context", {}), { stopReason: "toolUse" }),
			(context) => {
				sourceId = input(context).sources.find((source) => source.role === "user")!.id;
				return fauxAssistantMessage(
					[
						fauxToolCall(
							"memory_propose",
							{
								kind: "user",
								proposedText: preference,
								reason: "用户长期偏好",
								category: "preference",
								futureUse: "以后所有项目遵循用户明确的交流顺序",
								evidence: [{ sourceId, quote: preference }],
							},
							{ id: "saved-user" },
						),
						fauxToolCall(
							"memory_propose",
							{
								kind: "project",
								proposedText: `${fact}。`,
								reason: "长期工具约束",
								category: "environment",
								futureUse: "后续项目执行选择离线工具",
								evidence: [{ sourceId, quote: `${fact}。` }],
							},
							{ id: "invalid-fact" },
						),
					],
					{ stopReason: "toolUse" },
				);
			},
			(context) => {
				const rejected = context.messages.find(
					(message) => message.role === "toolResult" && message.toolCallId === "invalid-fact",
				);
				expect(rejected?.role === "toolResult" && rejected.isError).toBe(true);
				if (rejected?.role !== "toolResult") throw new Error("Missing rejected tool result");
				const rejectionText = rejected.content
					.filter((part) => part.type === "text")
					.map((part) => part.text)
					.join("\n");
				expect(rejectionText).toContain('"outcome": "rejected"');
				expect(rejectionText).toContain("This proposal was not saved");
				expect(rejectionText).toContain('"scope": "project"');
				const saved = context.messages.find(
					(message) => message.role === "toolResult" && message.toolCallId === "saved-user",
				);
				expect(saved?.role === "toolResult" && saved.isError).toBe(false);
				return fauxAssistantMessage(
					fauxToolCall("memory_propose", {
						kind: "project",
						proposedText: `${fact}。`,
						reason: "修正连续原文引用",
						category: "environment",
						futureUse: "后续项目执行选择离线工具",
						evidence: [{ sourceId, quote: fact }],
					}),
					{ stopReason: "toolUse" },
				);
			},
			(context) => {
				const saved = context.messages.at(-1);
				if (saved?.role !== "toolResult") throw new Error("Missing applied tool result");
				expect(
					saved.content
						.filter((part) => part.type === "text")
						.map((part) => part.text)
						.join("\n"),
				).toContain('"outcome": "applied"');
				return fauxAssistantMessage("已记录。");
			},
		]);
		await send(fixture, session.id, `${preference}${fact}，这是本项目的长期约束，请保存。`);
		const reviews = await fixture.application.services.learning.list(project.id);
		expect(reviews.filter((review) => review.changes[0]?.relativePath === "USER.md")).toHaveLength(1);
		expect((await fixture.application.services.semantic.list({ project })).map((item) => item.text)).toEqual(
			expect.arrayContaining([preference, `${fact}。`]),
		);
		expect(await readFile(project.memoryFilePath, "utf8")).not.toContain(preference);
	} finally {
		await fixture.close();
	}
});
