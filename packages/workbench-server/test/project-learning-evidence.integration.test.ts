import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Context } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { LearningReview } from "@earendil-works/workbench-core/contracts";
import { Type } from "typebox";
import { Parse } from "typebox/value";
import { expect, test, vi } from "vitest";
import { createAssistantFixture } from "./assistant-fixture.ts";
import {
	completeLearningTask,
	LEARNED_FACT,
	type LearningFixture,
	reviewOutput,
	similarityResponse,
} from "./project-learning-fixture.ts";

const SourcesSchema = Type.Object({
	sources: Type.Array(
		Type.Object({
			id: Type.String(),
			piEntryId: Type.String(),
			toolCallId: Type.Optional(Type.String()),
			role: Type.String(),
			text: Type.String(),
			verified: Type.Boolean(),
		}),
	),
});

function reviewSources(context: Context) {
	const message = context.messages.at(-1);
	if (message?.role !== "user") throw new Error("Expected isolated review input");
	const text =
		typeof message.content === "string"
			? message.content
			: message.content
					.filter((item) => item.type === "text")
					.map((item) => item.text)
					.join("\n");
	return Parse(SourcesSchema, JSON.parse(text)).sources;
}

async function settled(fixture: LearningFixture, projectId: string): Promise<LearningReview> {
	let review: LearningReview | undefined;
	await vi.waitFor(
		async () => {
			review = (await fixture.application.services.learning.list(projectId))[0];
			expect(review).toBeDefined();
			expect(["queued", "running"]).not.toContain(review!.status);
			expect(
				review!.changes.some(
					(change) => ["pending", "applying"].includes(change.status) && !change.autoBlockedReason,
				),
			).toBe(false);
		},
		{ timeout: 15000 },
	);
	return review!;
}

test.each(["piEntryId", "toolCallId"] as const)(
	"real Pi review resolves unique %s evidence to the bounded source and stores canonical references",
	async (reference) => {
		const fixture = await createAssistantFixture();
		try {
			const project = await fixture.application.createProject({ name: `证据引用 ${reference}` });
			let expectedIds: string[] = [];
			await completeLearningTask(fixture, project.id, "periodic", (context) => {
				const sources = reviewSources(context);
				const output = reviewOutput(context);
				expectedIds = [output.memories[0].evidence[0].sourceId, output.skills[0].evidence[0].sourceId].map(
					(id) => sources.find((source) => source.id === id)!.piEntryId,
				);
				for (const item of [...output.memories, ...output.skills]) {
					for (const evidence of item.evidence) {
						const source = sources.find((value) => value.id === evidence.sourceId)!;
						evidence.sourceId =
							reference === "toolCallId" && source.role === "tool" ? source.toolCallId! : source.piEntryId;
					}
				}
				return {
					...output,
					checkpoint: {
						constraints: [{ text: LEARNED_FACT, evidence: output.memories[0].evidence }],
						completedSteps: [{ text: output.skills[0].evidence[0].quote, evidence: output.skills[0].evidence }],
						nextSteps: [],
						unresolvedQuestions: [],
						temporaryConclusions: [],
					},
				};
			});
			const review = await settled(fixture, project.id);
			const snapshot = await fixture.application.repositories.learning.getSnapshot(review.sourceKey);
			expectedIds = expectedIds.map((id) => snapshot!.sources.find((source) => source.piEntryId === id)!.id);
			expect(review.error).toBeUndefined();
			expect(review.status).toBe("ready");
			expect(review.changes.flatMap((change) => change.evidence.map((value) => value.sourceId))).toEqual(
				expectedIds,
			);
			const response = await fixture.request(
				`/projects/${project.id}/learning/reviews/${review.id}/changes/${review.changes[0].id}/apply`,
				{
					method: "POST",
					body: JSON.stringify({ expectedVersion: review.version }),
				},
			);
			expect(response.status).toBe(409); // Already applied automatically; never apply the same journal twice.
			const fact = (await fixture.application.services.semantic.list({ project }))[0];
			expect(fact.evidence[0].piEntryId).toBeDefined();
			expect(fact.evidence[0].id).toBe(expectedIds[0]);
			const checkpoint = await fixture.application.services.memoryState.checkpoint(review.sessionId);
			expect(checkpoint?.constraints).toContain(LEARNED_FACT);
			expect(checkpoint?.completedSteps).toContain(review.changes[1].evidence[0].quote);
		} finally {
			await fixture.close();
		}
	},
);

test.each([
	["missing", "来源 ID 不在本轮"],
	["assistant", "来源未通过成功状态校验"],
	["user skill", "流程技能必须引用成功工具结果"],
	["paraphrase", "引用未逐字匹配"],
	["blank", "引用未逐字匹配"],
] as const)(
	"invalid %s evidence skips only its candidate and can be retried without changing the task",
	async (scenario, reason) => {
		const fixture = await createAssistantFixture();
		try {
			const project = await fixture.application.createProject({ name: `证据拒绝 ${scenario}` });
			const before = await readFile(project.memoryFilePath, "utf8");
			const { session } = await completeLearningTask(fixture, project.id, "periodic", (context) => {
				const sources = reviewSources(context);
				const output = reviewOutput(context);
				if (scenario === "missing") output.memories[0].evidence[0].sourceId = "not-in-this-turn";
				if (scenario === "assistant") {
					const assistant = sources.find((value) => value.role === "assistant")!;
					output.memories[0].evidence = [{ sourceId: assistant.piEntryId, quote: assistant.text }];
				}
				if (scenario === "user skill") output.skills[0].evidence = output.memories[0].evidence;
				if (scenario === "paraphrase")
					output.memories[0].evidence[0].quote = "private-diagnostic-payload 不存在于原文";
				if (scenario === "blank") output.memories[0].evidence[0].quote = "    ";
				return output;
			});
			const failed = await settled(fixture, project.id);
			expect(failed.status).toBe("ready");
			expect(failed.diagnostics?.[0].message).toContain("复盘证据未通过原文与成功状态校验");
			expect(failed.diagnostics?.[0].message).toContain(reason);
			expect(failed.diagnostics?.[0].message).toContain(scenario === "user skill" ? "技能第1项" : "事实第1项");
			expect(failed.diagnostics?.[0].message).not.toContain("private-diagnostic-payload");
			expect(failed.changes).toHaveLength(1);
			if (scenario !== "user skill") expect(await readFile(project.memoryFilePath, "utf8")).toBe(before);
			else expect(await readFile(project.memoryFilePath, "utf8")).toContain(LEARNED_FACT);
			expect((await fixture.application.services.sessions.get(session.id)).status).toBe("idle");
			fixture.faux.setResponses([
				(context) => fauxAssistantMessage(JSON.stringify({ ...reviewOutput(context), skills: [] })),
				...(scenario === "user skill" ? [(context: Context) => similarityResponse(context)] : []),
			]);
			const response = await fixture.request(`/projects/${project.id}/learning/reviews/${failed.id}/retry`, {
				method: "POST",
			});
			expect(response.status).toBe(202);
			const retried = await settled(fixture, project.id);
			expect(retried.status).toBe("ready");
			expect(retried.diagnostics).toEqual([]);
			expect(retried.id).not.toBe(failed.id);
			expect((await fixture.application.services.learning.get(failed.id)).status).toBe("ready");
		} finally {
			await fixture.close();
		}
	},
);

test("a real successful tool's omitted tail is not evidence and a failed tool cannot be verified by its Pi entry ID", async () => {
	const fixture = await createAssistantFixture();
	try {
		const project = await fixture.application.createProject({ name: "长原文与失败工具" });
		const tail = "仅存在于原始文件末尾的依据";
		await writeFile(join(project.workspacePath, "long-source.txt"), `${"限长的前段资料。".repeat(300)}\n${tail}`);
		const session = await fixture.application.createSession({ projectId: project.id });
		fixture.faux.setResponses([
			() => fauxAssistantMessage(fauxToolCall("read", { path: "long-source.txt" }), { stopReason: "toolUse" }),
			() => fauxAssistantMessage("已读取长资料。"),
		]);
		const initial = fixture.application.events.start(session.id, { text: "阅读长资料，记住有依据的项目事实。" });
		for await (const _event of fixture.application.events.subscribe(initial.runId)) {
			/* Drain real Pi events. */
		}
		expect(await readFile(session.runtimeRef, "utf8")).toContain(tail);
		fixture.faux.setResponses([
			(context) => {
				const tool = reviewSources(context).find((source) => source.role === "tool")!;
				expect(tool.verified).toBe(true);
				expect(tool.text).not.toContain(tail);
				return fauxAssistantMessage(
					JSON.stringify({
						summary: "原文截断校验",
						memories: [{ text: "不应写入截断的结论", evidence: [{ sourceId: tool.piEntryId, quote: tail }] }],
						skills: [],
					}),
				);
			},
		]);
		await fixture.application.services.learning.reviewSession(session.id);
		expect((await settled(fixture, project.id)).diagnostics?.[0].message).toContain("引用未逐字匹配");
		fixture.faux.setResponses([
			() => fauxAssistantMessage(fauxToolCall("read", { path: "missing-source.txt" }), { stopReason: "toolUse" }),
			() => fauxAssistantMessage("读取失败，需要另行确认。"),
		]);
		const next = fixture.application.events.start(session.id, { text: "读取缺失文件" });
		for await (const _event of fixture.application.events.subscribe(next.runId)) {
			/* Drain real Pi events. */
		}
		fixture.faux.setResponses([
			(context) => {
				const failed = reviewSources(context).find((source) => source.role === "tool")!;
				expect(failed.verified).toBe(false);
				return fauxAssistantMessage(
					JSON.stringify({
						summary: "失败不能晋升",
						memories: [
							{
								text: "不应写入失败结论",
								evidence: [{ sourceId: failed.piEntryId, quote: failed.text.slice(0, 100) }],
							},
						],
						skills: [],
					}),
				);
			},
		]);
		await fixture.application.services.learning.reviewSession(session.id);
		expect((await settled(fixture, project.id)).status).toBe("empty");
		expect(fixture.faux.getPendingResponseCount()).toBe(1);
		expect(await fixture.application.services.semantic.list({ project })).toEqual([]);
	} finally {
		await fixture.close();
	}
});

test("review supplies the real output schema and rejects an invalid skill slug without dropping its valid fact", async () => {
	const fixture = await createAssistantFixture();
	try {
		const project = await fixture.application.createProject({ name: "技能结构校验" });
		await completeLearningTask(fixture, project.id, "periodic", (context) => {
			const message = context.messages.at(-1);
			if (message?.role !== "user") throw new Error("Expected bounded review JSON");
			const text =
				typeof message.content === "string"
					? message.content
					: message.content
							.filter((item) => item.type === "text")
							.map((item) => item.text)
							.join("\n");
			const input = Parse(
				Type.Object({ outputSchema: Type.Object({ properties: Type.Unknown() }) }),
				JSON.parse(text),
			);
			expect(input.outputSchema.properties).toHaveProperty("skills.items.properties.slug.pattern");
			const output = reviewOutput(context);
			output.skills[0].slug = "learned-库存";
			return output;
		});
		const review = await settled(fixture, project.id);
		expect(review.changes).toHaveLength(1);
		expect(review.changes[0]).toMatchObject({ kind: "memory", status: "applied" });
		expect(review.diagnostics?.[0].message).toContain("/slug:pattern");
		expect(review.diagnostics?.[0].message).not.toContain("learned-库存");
		expect(await fixture.application.services.learning.reusableSkills(project.id)).toEqual([]);
	} finally {
		await fixture.close();
	}
});

test("review rejects a valid foreign project reference and ambiguous tool-call aliases", async () => {
	const fixture = await createAssistantFixture();
	try {
		const foreign = await fixture.application.createProject({ name: "其他项目的证据" });
		const { session: foreignSession } = await completeLearningTask(fixture, foreign.id, "deferred");
		const foreignTool = (await fixture.application.services.sessions.readTranscript(foreignSession.id)).find(
			(source) => source.role === "tool",
		)!;
		const project = await fixture.application.createProject({ name: "当前项目的证据" });
		const { session } = await completeLearningTask(fixture, project.id, "deferred");
		fixture.faux.setResponses([
			(context) => {
				const output = reviewOutput(context);
				output.memories[0].evidence = [
					{
						sourceId: foreignTool.piEntryId!,
						quote: foreignTool.content
							.filter((item) => item.type === "text")
							.map((item) => item.text)
							.join("\n")
							.slice(0, 100),
					},
				];
				output.skills = [];
				return fauxAssistantMessage(JSON.stringify(output));
			},
		]);
		await fixture.application.services.learning.reviewSession(session.id);
		expect((await settled(fixture, project.id)).diagnostics?.[0].message).toContain("来源 ID 不在本轮");
		const original = await settled(fixture, project.id);
		const tool = (await fixture.application.services.sessions.readTranscript(session.id)).find(
			(source) => source.role === "tool",
		)!;
		SessionManager.open(session.runtimeRef).appendMessage({
			role: "toolResult",
			toolCallId: tool.toolCallId!,
			toolName: "ls",
			isError: false,
			content: [{ type: "text", text: "同一调用 ID 的另一条返回" }],
			timestamp: Date.now(),
		});
		await fixture.restart();
		fixture.faux.setResponses([
			(context) => {
				const output = reviewOutput(context);
				output.skills = [];
				return fauxAssistantMessage(JSON.stringify(output));
			},
		]);
		await fixture.application.services.learning.retry(original.id);
		const retry = await settled(fixture, project.id);
		expect(retry.changes).toHaveLength(1);
		expect(retry.diagnostics).toEqual([]);
		const snapshot = await fixture.application.repositories.learning.getSnapshot(original.sourceKey);
		expect(snapshot?.sources.filter((source) => source.toolCallId === tool.toolCallId)).toHaveLength(1);
		expect((await fixture.application.services.semantic.list({ project })).map((fact) => fact.text)).toEqual([
			LEARNED_FACT,
		]);
	} finally {
		await fixture.close();
	}
});
