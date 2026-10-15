import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Context } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { DEFAULT_MEMORY_POLICY, semanticBlocks, semanticMarkdown } from "@earendil-works/workbench-core";
import type { LearningReview } from "@earendil-works/workbench-core/contracts";
import { Type } from "typebox";
import { Parse } from "typebox/value";
import { expect, test, vi } from "vitest";
import { createAssistantFixture } from "./assistant-fixture.ts";
import {
	completeLearningTask,
	LEARNED_FACT,
	LEARNED_INSTRUCTIONS,
	type LearningFixture,
	reviewOutput,
	similarityResponse,
} from "./project-learning-fixture.ts";

function inputText(context: Context): string {
	const message = context.messages.at(-1);
	if (message?.role !== "user") throw new Error("Missing processing input");
	return typeof message.content === "string"
		? message.content
		: message.content
				.filter((part) => part.type === "text")
				.map((part) => part.text)
				.join("\n");
}
async function reviewReady(fixture: LearningFixture, projectId: string): Promise<LearningReview> {
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

test("records failed and successful attempts across restart and extracts a success with the actual failure cause", async () => {
	const fixture = await createAssistantFixture();
	try {
		const project = await fixture.application.createProject({ name: "失败后恢复" });
		await fixture.application.services.learning.configure(project.id, { memoryInterval: 1, skillInterval: 0 });
		const session = await fixture.application.createSession({ projectId: project.id });
		fixture.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("read", { path: "missing-evidence.txt" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "fixture failure" }),
		]);
		const failed = fixture.application.events.start(session.id, {
			text: "读取 missing-evidence.txt，缺失时先保留失败原因。",
		});
		for await (const _entry of fixture.application.events.subscribe(failed.runId)) {
			/* drain */
		}
		await vi.waitFor(async () =>
			expect(
				await fixture.application.repositories.learning.getSnapshot(`observation:${failed.runId}`),
			).toMatchObject({ unverified: true }),
		);
		expect(await fixture.application.services.learning.list(project.id)).toEqual([]);
		await fixture.restart();
		fixture.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("read", { path: "AGENTS.md" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("已从正确文件读取项目约定。"),
			(context) => {
				const input = Parse(
					Type.Object({
						sources: Type.Array(
							Type.Object({
								id: Type.String(),
								role: Type.String(),
								text: Type.String(),
								verified: Type.Boolean(),
								runVerified: Type.Boolean(),
							}),
						),
					}),
					JSON.parse(inputText(context)),
				);
				const failure = input.sources.find((source) => source.role === "tool" && !source.verified)!;
				const success = input.sources.find(
					(source) => source.role === "tool" && source.verified && source.runVerified,
				)!;
				expect(failure.text).toContain("missing-evidence.txt");
				expect(failure.runVerified).toBe(false);
				return fauxAssistantMessage(
					JSON.stringify({
						summary: "文件缺失后改用项目约定文件成功读取",
						memories: [],
						skills: [
							{
								slug: "learned-read-conventions",
								title: "读取项目约定",
								description: "读取项目约定文件时使用。",
								confidence: 0.88,
								instructions:
									"## 适用条件\n需要读取项目约定时。\n\n## 步骤\n1. 核对文件位置。\n2. 使用 read 读取 AGENTS.md。\n\n## 验证\n核对工具返回的约定原文。",
								evidence: [{ sourceId: success.id, quote: success.text.slice(0, 100) }],
								recoveredFailures: [{ sourceId: failure.id, quote: failure.text.slice(0, 100) }],
							},
						],
					}),
				);
			},
		]);
		const succeeded = fixture.application.events.start(session.id, { text: "继续刚才的读取任务，改读 AGENTS.md。" });
		for await (const _entry of fixture.application.events.subscribe(succeeded.runId)) {
			/* drain */
		}
		const review = await reviewReady(fixture, project.id);
		expect(review.diagnostics).toEqual([]);
		expect(review.changes).toHaveLength(1);
		const body = await fixture.application.services.skills.readContent(review.changes[0].skillId!);
		expect(body.content).toContain("## 成功方案");
		expect(body.content).toContain("## 注意");
		expect(body.content).toContain("missing-evidence.txt");
		expect(body.content).toContain("confidence: 0.88");
		expect(body.content).toContain("last_verified_at:");
		expect(
			await fixture.application.repositories.learning.getSnapshot(`observation:${succeeded.runId}`),
		).toMatchObject({ unverified: false });
	} finally {
		await fixture.close();
	}
});

test("LLM similarity merges paraphrased facts and skips duplicate procedures without creating another skill", async () => {
	const fixture = await createAssistantFixture();
	try {
		const project = await fixture.application.createProject({ name: "语义比较" });
		await completeLearningTask(fixture, project.id);
		const first = await reviewReady(fixture, project.id);
		const skillId = first.changes.find((change) => change.kind === "skill")!.skillId;
		await completeLearningTask(fixture, project.id, "periodic", (context) => {
			fixture.faux.appendResponses([(input) => similarityResponse(input), (input) => similarityResponse(input)]);
			const output = reviewOutput(context);
			output.memories[0].text = "本项目的运行环境版本为 Python 3.12。";
			output.skills[0].slug = "learned-another-title";
			output.skills[0].description = "在开展项目工作前查看文件结构。";
			return output;
		});
		const second = await reviewReady(fixture, project.id);
		expect(second.diagnostics).toEqual([]);
		expect(second.changes).toHaveLength(1);
		expect(second.changes[0].similarity?.relation).toBe("duplicate");
		expect(
			(await fixture.application.services.semantic.list({ project })).filter((fact) => fact.text.includes("Python")),
		).toHaveLength(1);
		expect((await fixture.application.services.learning.reusableSkills(project.id)).map((skill) => skill.id)).toEqual(
			[skillId],
		);
		expect(fixture.faux.getPendingResponseCount()).toBe(0);
		await completeLearningTask(fixture, project.id, "periodic", (context) => {
			fixture.faux.appendResponses([() => fauxAssistantMessage("invalid similarity JSON")]);
			return { ...reviewOutput(context), memories: [] };
		});
		const refused = await reviewReady(fixture, project.id);
		expect(refused.changes).toEqual([]);
		expect(refused.diagnostics).toHaveLength(1);
		expect((await fixture.application.services.learning.reusableSkills(project.id)).map((skill) => skill.id)).toEqual(
			[skillId],
		);
		expect(await fixture.application.repositories.learning.getSnapshot(refused.sourceKey)).toBeDefined();
	} finally {
		await fixture.close();
	}
});

test("consolidation retires low confidence, preserves age, uses bounded summaries and rejects stale or oversized indexes", async () => {
	const fixture = await createAssistantFixture();
	try {
		const project = await fixture.application.createProject({ name: "定时记忆浓缩" });
		const session = await fixture.application.createSession({ projectId: project.id });
		const { memory, semantic, settings, memoryMaintenance, retrieval } = fixture.application.services;
		expect(await (await fixture.request("/memory/maintenance")).json()).toMatchObject({
			policy: DEFAULT_MEMORY_POLICY,
		});
		const path = `projects/${project.slug}/AGENTS.md`;
		const before = await readFile(project.memoryFilePath, "utf8");
		const prepared = await semantic.prepare(
			before,
			"project",
			path,
			project.id,
			{
				kind: "project",
				proposedText: "只有部署到测试环境时才先检查服务健康，再核对依赖版本。",
				reason: "已验证",
				sessionId: session.id,
				semanticChange: { operation: "create", confidence: 0.8 },
			},
			"old-verified-fact",
			"verified",
		);
		const block = semanticBlocks(prepared.preview, "project", path, project.id)[0];
		const old = "2025-01-01T00:00:00.000Z";
		const aged = semanticMarkdown({
			...block.record,
			createdAt: old,
			lastVerifiedAt: old,
			updatedAt: old,
			validFrom: old,
		});
		await memory.edit(
			path,
			`${before}\n${aged}\n`,
			createHash("sha256").update(before).digest("hex"),
			"project",
			project.id,
		);
		const low = await memory.propose(
			{ project },
			{
				kind: "project",
				proposedText: "LOW-CONFIDENCE 旧猜测",
				reason: "待核验",
				semanticChange: { operation: "create", confidence: 0.59 },
			},
		);
		await memory.accept(low.id);
		expect(await memory.search({ project }, "LOW-CONFIDENCE")).toEqual([]);
		const calls: string[] = [];
		const condense = (context: Context) => {
			expect(context.tools ?? []).toHaveLength(0);
			const input = Parse(
				Type.Object({
					operation: Type.Literal("memory-consolidation"),
					sources: Type.Array(Type.Object({ id: Type.String(), timestamp: Type.String() })),
				}),
				JSON.parse(inputText(context)),
			);
			calls.push(input.operation);
			expect(input.sources).toHaveLength(1);
			expect(input.sources[0].timestamp).toBe(old);
			return fauxAssistantMessage(
				JSON.stringify({
					entries: input.sources.map((source) => ({ id: source.id, text: "测试环境部署前检查健康和依赖版本。" })),
				}),
			);
		};
		fixture.faux.setResponses([condense]);
		await memoryMaintenance.run();
		expect(calls).toEqual([]);
		await settings.set("memory.maintenance.startedAt", old);
		await Promise.all([memoryMaintenance.run(), memoryMaintenance.run()]);
		expect(calls).toHaveLength(1);
		const digestPath = join(project.workspacePath, "memory", "main.md");
		const digest = await readFile(digestPath, "utf8");
		expect(digest).not.toContain("LOW-CONFIDENCE");
		for (const line of digest.split("\n").filter((line) => line.startsWith("- ")))
			expect(Array.from(line.slice(2)).length).toBeLessThanOrEqual(120);
		expect(digest).toContain(old);
		expect(digest).toContain("置信度：0.8");
		expect(await fixture.application.repositories.semantic.getSemantic(low.id)).toMatchObject({
			status: "invalidated",
			confidence: 0.59,
		});
		expect((await semantic.history(low.id, { project })).length).toBe(2);
		const context = await retrieval.retrieve({ sessionId: session.id, query: "无匹配词 zebra" });
		const fact = context.memory.fragments.find((item) => item.id === "old-verified-fact")!;
		expect(fact.text).toContain("测试环境部署前检查健康和依赖版本。");
		expect(fact.text).toContain("请复核");
		expect(fact.reason).toContain("main.md");
		expect(fact.text).not.toContain("只有部署");
		await fixture.restart();
		await fixture.application.services.memoryMaintenance.run();
		expect(calls).toHaveLength(1);
		expect(await fixture.application.repositories.semantic.getSemantic("old-verified-fact")).toMatchObject({
			lastVerifiedAt: old,
			confidence: 0.8,
		});
		fixture.faux.setResponses([
			(context) => {
				const input = Parse(
					Type.Object({ sources: Type.Array(Type.Object({ id: Type.String() })) }),
					JSON.parse(inputText(context)),
				);
				return fauxAssistantMessage(
					JSON.stringify({ entries: input.sources.map((source) => ({ id: source.id, text: "字".repeat(121) })) }),
				);
			},
		]);
		await expect(fixture.application.services.memoryMaintenance.run(true)).rejects.toThrow();
		expect(await readFile(digestPath, "utf8")).toBe(digest);
		fixture.faux.setResponses([
			async (context) => {
				const input = Parse(
					Type.Object({ sources: Type.Array(Type.Object({ id: Type.String() })) }),
					JSON.parse(inputText(context)),
				);
				await fixture.application.services.semantic.change(
					{ project },
					{
						kind: "project",
						proposedText: "新环境部署前先核对依赖版本。",
						reason: "浓缩期间的新证据",
						semanticChange: { operation: "update", targetId: "old-verified-fact", expectedVersion: 1 },
					},
				);
				return fauxAssistantMessage(
					JSON.stringify({
						entries: input.sources.map((source) => ({ id: source.id, text: "旧的健康检查流程。" })),
					}),
				);
			},
		]);
		await expect(fixture.application.services.memoryMaintenance.run(true)).rejects.toMatchObject({
			code: "conflict",
		});
		expect(await readFile(digestPath, "utf8")).toBe(digest);
		expect(await fixture.application.services.memoryMaintenance.read(project)).toEqual([]);
		await fixture.application.services.semantic.change(
			{ project },
			{
				kind: "project",
				proposedText: "失效",
				reason: "新证据推翻",
				semanticChange: { operation: "invalidate", targetId: "old-verified-fact", expectedVersion: 2 },
			},
		);
		expect(await fixture.application.services.memoryMaintenance.read(project)).toEqual([]);
		const changed = await fixture.application.services.retrieval.retrieve({ sessionId: session.id, query: "部署" });
		expect(changed.memory.fragments.some((item) => item.id === "old-verified-fact")).toBe(false);
	} finally {
		await fixture.close();
	}
});

test("invalid policy values are rejected and low confidence experience never enters the skill catalog", async () => {
	const fixture = await createAssistantFixture();
	try {
		const invalid: Array<Record<string, number>> = [
			{ confidenceThreshold: 1.1 },
			{ staleAfterDays: 0 },
			{ consolidationIntervalHours: 0 },
			{ maxEntryCharacters: 0 },
		];
		for (const value of invalid)
			await expect(fixture.application.services.settings.set("memory.policy", value)).rejects.toThrow();
		const project = await fixture.application.createProject({ name: "低置信度经验" });
		await completeLearningTask(fixture, project.id, "periodic", (context) => {
			const output = reviewOutput(context);
			output.skills[0].confidence = 0.59;
			output.memories[0].confidence = 0.59;
			return output;
		});
		const review = await reviewReady(fixture, project.id);
		expect(review.changes).toEqual([]);
		expect(review.diagnostics).toHaveLength(2);
		expect(await fixture.application.services.learning.reusableSkills(project.id)).toEqual([]);
		expect(await readFile(project.memoryFilePath, "utf8")).not.toContain(LEARNED_FACT);
		expect(await readFile(project.memoryFilePath, "utf8")).not.toContain(LEARNED_INSTRUCTIONS);
	} finally {
		await fixture.close();
	}
});

import { createHash } from "node:crypto";
