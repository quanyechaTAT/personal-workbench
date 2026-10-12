import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import type { WorkingCheckpoint } from "@earendil-works/workbench-core";
import { expect, test } from "vitest";
import { createAssistantFixture } from "./assistant-fixture.ts";
import { createPerceptionFixture, imageDocument } from "./perception-fixture.ts";

test("episode vectors recall nonliteral experiences, isolate scopes before distance ranking and share one query embedding", async () => {
	const setup = await createPerceptionFixture();
	try {
		const project = await setup.project("经历向量");
		const other = await setup.project("隔离向量");
		const session = await setup.fixture.application.createSession({ projectId: project.id });
		const privateSession = await setup.fixture.application.createSession({ projectId: other.id });
		for (const current of [session, privateSession]) {
			setup.fixture.faux.setResponses([
				fauxAssistantMessage(fauxToolCall("ls", { path: "." }), { stopReason: "toolUse" }),
				fauxAssistantMessage(
					current.id === session.id ? "已检查目录，但具体原因仍未验证。" : "PRIVATE-ONLY 隔离经验。",
				),
			]);
			const run = setup.fixture.application.events.start(current.id, { text: "完成目录检查" });
			for await (const _event of setup.fixture.application.events.subscribe(run.runId)) {
				/* real Pi */
			}
			expect(
				(await setup.fixture.request(`/sessions/${current.id}/memory/rebuild`, { method: "POST" })).status,
			).toBe(200);
		}
		const before = setup.counts.text;
		const result = await setup.fixture.application.services.retrieval.retrieve({
			sessionId: session.id,
			query: "特殊同义表达",
		});
		expect(setup.counts.text - before).toBe(1);
		expect(result.memory.fragments.filter((item) => item.layer === "episodic")).toHaveLength(1);
		expect(JSON.stringify(result)).not.toContain("PRIVATE-ONLY");
		const episode = (await setup.fixture.application.services.memoryState.episodes(session.id))[0];
		await setup.fixture.application.repositories.memoryState.saveEpisodeVector(
			episode.id,
			episode.version,
			"changed-dimension",
			[1, 0],
		);
		await expect(
			setup.fixture.application.repositories.memoryState.searchEpisodeVectors(
				{ projectId: project.id },
				"changed-dimension",
				[1, 0, 0],
			),
		).rejects.toThrow("维度");
		expect(
			await setup.fixture.application.repositories.memoryState.searchEpisodeVectors(
				{ projectId: project.id },
				"new-space",
				[1, 0, 0],
			),
		).toEqual([]);
	} finally {
		await setup.close();
	}
});

test("unified context uses current facts, scoped episodes/perception and one shared text query embedding; Inspector records the real request", async () => {
	const setup = await createPerceptionFixture();
	try {
		const project = await setup.project("统一上下文 中文");
		await setup.fixture.application.services.knowledge.configure(project, {
			maxChunkTokens: 256,
			minChunkTokens: 16,
			contextTokens: 2048,
			queryTokens: 512,
			mqe: "off",
			mqeTimeoutMs: 3000,
		});
		const document = await setup.fixture.application.services.knowledge.upload(
			project,
			"版本截图.png",
			imageDocument(),
		);
		expect((await setup.wait(project, document.id)).status).toBe("ready");
		const old = await setup.fixture.application.services.memory.propose(
			{ project },
			{ kind: "project", proposedText: "项目使用 Python 3.10。", reason: "旧版本" },
		);
		await setup.fixture.application.services.memory.accept(old.id);
		const updated = await setup.fixture.application.services.memory.propose(
			{ project },
			{ kind: "project", proposedText: "项目使用 Python 3.12。", reason: "用户已迁移" },
		);
		await setup.fixture.application.services.memory.accept(updated.id);
		await setup.fixture.application.services.semantic.rebuildVectors({ project });
		const first = await setup.fixture.application.createSession({ projectId: project.id });
		const second = await setup.fixture.application.createSession({ projectId: project.id });
		const now = new Date().toISOString();
		const checkpoint = (sessionId: string, goal: string): WorkingCheckpoint => ({
			sessionId,
			projectId: project.id,
			goal,
			nextSteps: ["验证版本"],
			completedSteps: [],
			constraints: ["不要覆盖未提交修改"],
			temporaryConclusions: [],
			unresolvedQuestions: ["尚未验证真实 OCR 权限"],
			sources: [],
			sourceSequence: 1,
			status: "completed",
			version: 1,
			updatedAt: now,
			expiresAt: new Date(Date.now() + 86400000).toISOString(),
		});
		await setup.fixture.application.repositories.memoryState.saveCheckpoint(checkpoint(first.id, "甲会话目标"), 0);
		await setup.fixture.application.repositories.memoryState.saveCheckpoint(checkpoint(second.id, "乙会话目标"), 0);
		await setup.fixture.application.repositories.memoryState.saveEpisode({
			id: "python-failure",
			projectId: project.id,
			sessionId: first.id,
			runId: "past-run",
			occurredAt: now,
			summary: "Python 迁移失败",
			actions: [{ tool: "verify", result: "验证失败", verified: false }],
			result: "原因尚不明确",
			outcome: "failure",
			sources: [],
			semanticIds: [],
			skillIds: [],
			retention: "keep",
			version: 1,
			updatedAt: now,
		});
		const before = setup.counts.text;
		const preview = await setup.fixture.application.contextForSession(first.id, "Python 版本");
		expect(setup.counts.text - before).toBe(1);
		expect(preview.memory?.fragments.map((fragment) => fragment.layer)).toEqual(
			expect.arrayContaining(["working", "semantic", "episodic", "perceptual"]),
		);
		const facts = preview.memory?.fragments
			.filter((fragment) => fragment.layer === "semantic")
			.map((fragment) => fragment.text)
			.join("\n");
		expect(facts).toContain("3.12");
		expect(facts).not.toContain("3.10");
		expect(preview.runtime.appendSystemPrompt?.join("\n")).not.toContain("workbench-semantic");
		expect(preview.memory?.characters).toBeLessThanOrEqual(24000);
		const otherPreview = await setup.fixture.application.contextForSession(second.id, "Python 版本");
		expect(otherPreview.memory?.fragments.find((fragment) => fragment.layer === "working")?.text).toContain(
			"乙会话目标",
		);
		expect(otherPreview.memory?.fragments.find((fragment) => fragment.layer === "working")?.text).not.toContain(
			"甲会话目标",
		);
		setup.fixture.faux.setResponses([
			(context) => {
				expect(context.systemPrompt).toContain("3.12");
				expect(context.systemPrompt?.match(/.{0,120}3\.10.{0,120}/gu)).toBeNull();
				const user = context.messages.find((message) => message.role === "user");
				expect(JSON.stringify(user)).toContain("尚未验证真实 OCR 权限");
				return fauxAssistantMessage("依据当前有效版本和截图继续验证。");
			},
		]);
		const response = await setup.fixture.request(`/sessions/${first.id}/messages`, {
			method: "POST",
			body: JSON.stringify({ text: "继续验证 Python 版本" }),
		});
		const run = (await response.json()) as { runId: string };
		expect(await (await setup.fixture.request(`/runs/${run.runId}/events`)).text()).toContain(
			'"type":"run.completed"',
		);
		const actual = await setup.fixture.application.repositories.memoryState.getContext(first.id);
		expect(actual).toMatchObject({ sessionId: first.id, runId: run.runId, request: 1 });
		expect(actual?.fragments.find((fragment) => fragment.layer === "working")?.text).toContain("甲会话目标");
		expect(actual?.fragments.filter((fragment) => fragment.layer === "perceptual")).toHaveLength(1);
		expect(actual?.characters).toBeLessThanOrEqual(24000);
		const tiny = await setup.fixture.application.services.retrieval.retrieve({
			sessionId: first.id,
			query: "Python",
			budget: 2000,
		});
		expect(tiny.memory.characters).toBeLessThanOrEqual(2000);
		const otherProject = await setup.project("不应召回");
		await expect(
			setup.fixture.application.services.retrieval.retrieve({
				sessionId: first.id,
				projectId: otherProject.id,
				query: "Python",
			}),
		).rejects.toThrow("范围");
		const minimal = await setup.fixture.application.createSession({ profileSlug: "minimal", projectId: project.id });
		expect((await setup.fixture.application.contextForSession(minimal.id, "Python")).memory).toBeUndefined();
	} finally {
		await setup.close();
	}
});

test("isolated checkpoint consolidation cites sources, rejects fabricated constraints and cannot fail or overwrite a newer run", async () => {
	const fixture = await createAssistantFixture();
	try {
		await fixture.application.services.settings.set("memory.checkpointReviewEnabled", true);
		const session = await fixture.application.createSession({});
		fixture.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("ls", { path: "." }), { stopReason: "toolUse" }),
			fauxAssistantMessage("已完成目录检查，还需验证权限。"),
			(context) => {
				expect(context.tools ?? []).toHaveLength(0);
				expect(context.systemPrompt).toContain("紧凑工作检查点");
				const user = context.messages.at(-1);
				if (user?.role !== "user") throw new Error("Expected checkpoint JSON");
				const body =
					typeof user.content === "string"
						? user.content
						: user.content
								.filter((part) => part.type === "text")
								.map((part) => (part.type === "text" ? part.text : ""))
								.join("\n");
				const input = JSON.parse(body) as { sources: Array<{ id: string; role: string; text: string }> };
				const source = input.sources.find((value) => value.role === "user")!;
				return fauxAssistantMessage(
					JSON.stringify({
						completedSteps: [],
						nextSteps: [{ text: "继续验证权限", evidence: [{ sourceId: source.id, quote: "检查当前目录" }] }],
						constraints: [
							{ text: "未经验证也可以修改所有文件", evidence: [{ sourceId: source.id, quote: "检查当前目录" }] },
						],
						unresolvedQuestions: [],
						temporaryConclusions: [],
					}),
				);
			},
		]);
		const run = fixture.application.events.start(session.id, {
			text: "检查当前目录，并在完成后保留待验证权限这一问题。",
		});
		for await (const _event of fixture.application.events.subscribe(run.runId)) {
			/* real Pi stream */
		}
		await expect
			.poll(async () => (await fixture.application.services.memoryState.checkpoint(session.id))?.review?.status)
			.toBe("complete");
		const checkpoint = (await fixture.application.services.memoryState.checkpoint(session.id))!;
		expect(checkpoint.constraints).not.toContain("未经验证也可以修改所有文件");
		expect(checkpoint.nextSteps).toContain("继续验证权限");
		fixture.faux.setResponses([fauxAssistantMessage("第二轮保持检查目标。"), fauxAssistantMessage("不是合法 JSON")]);
		const next = fixture.application.events.start(session.id, {
			text: "继续检查当前目录，保持本次任务目标及所有已确认限制。",
		});
		for await (const _event of fixture.application.events.subscribe(next.runId)) {
			/* drain */
		}
		await expect
			.poll(async () => (await fixture.application.services.memoryState.checkpoint(session.id))?.review?.status)
			.toBe("failed");
		expect((await fixture.application.repositories.agentRuns.get(next.runId))?.status).toBe("completed");
		expect(
			await fixture.application.services.memoryState.applySummary(
				session.id,
				run.runId,
				checkpoint.version,
				{ completedSteps: [], nextSteps: [], constraints: [], unresolvedQuestions: [], temporaryConclusions: [] },
				[],
			),
		).toBe(false);
		expect(JSON.stringify(await fixture.application.services.sessions.readTranscript(session.id))).not.toContain(
			"紧凑工作检查点",
		);
	} finally {
		await fixture.close();
	}
});
