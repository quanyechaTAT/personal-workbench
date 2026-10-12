import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { expect, test } from "vitest";
import { createKnowledgeFixture } from "./knowledge-rag-fixture.ts";

const query = "如何寻找内容";
const hypothesis =
	"假设检索文档讨论稀疏索引匹配机制与候选召回，并解释如何寻找内容。假设标记仅用于测试，实际回答仍需依据已有来源。";

test("HyDE uses the selected conversation LLM across switches, HTTP chat/tool calls and restart without injecting its document", async () => {
	const rig = await createKnowledgeFixture((text) => (text.includes("稀疏索引") ? [1, 0] : [0, 1]));
	const { fixture } = rig;
	try {
		const { application } = fixture;
		const firstModel = fixture.model;
		const secondModel = { ...firstModel, id: "selected-hyde-llm", name: "Selected HyDE LLM" };
		fixture.modelRuntime.registerProvider(firstModel.provider, {
			api: firstModel.api,
			baseUrl: firstModel.baseUrl,
			models: [firstModel, secondModel],
		});
		const catalog = application.runtime.modelCatalog;
		const provider = (await catalog?.providers())?.find((entry) => entry.id === firstModel.provider);
		if (!catalog || !provider) throw new Error("Missing Pi fixture catalog");
		await catalog.apply([provider], new Map());
		const first = { provider: firstModel.provider, modelId: firstModel.id };
		const second = { provider: secondModel.provider, modelId: secondModel.id };
		await application.services.settings.set("models.default", first);
		const project = await rig.project("HyDE 项目");
		const other = await rig.project("其他 HyDE 项目");
		await writeFile(
			join(project.sourcePath ?? "", "actual.md"),
			"# 技术笔记\n\n稀疏索引匹配机制用于候选召回。真实证据保存在当前项目。",
		);
		await writeFile(join(other.sourcePath ?? "", "private.md"), "# 隔离资料\n\n稀疏索引 PRIVATE-ONLY 机密。");
		await application.services.knowledge.index(project);
		await application.services.knowledge.index(other);
		const indexed = await application.repositories.knowledge.listChunks(project.id);
		await application.services.knowledge.configure(project, { mqe: "off", hyde: "always", hydeTimeoutMs: 5000 });
		expect((await application.services.knowledge.status(project)).staleFileCount).toBe(0);
		const session = await application.createSession({ projectId: project.id, model: second });
		const observed: string[] = [];
		const respond = () =>
			fixture.faux.appendResponses([
				(context, options, _state, model) => {
					observed.push(model.id);
					expect(context.tools?.length ?? 0).toBe(0);
					expect(context.systemPrompt).toContain("HyDE 假设检索文档生成器");
					expect(context.messages).toHaveLength(1);
					expect(options?.maxRetries).toBe(0);
					expect(JSON.stringify(context)).not.toContain("fixture-secret");
					return fauxAssistantMessage(JSON.stringify({ document: hypothesis }));
				},
			]);
		respond();
		const initial = await application.contextForSession(session.id, query);
		expect(initial.knowledge?.hyde).toMatchObject({ applied: true, model: second, document: hypothesis });
		expect(initial.knowledge?.queries).toEqual([query]);
		expect(initial.knowledge?.hits[0].matches?.some((match) => match.method === "hyde")).toBe(true);
		expect(JSON.stringify(initial.turn)).not.toContain("假设标记");
		expect(JSON.stringify(initial.knowledge?.hits)).not.toContain("PRIVATE-ONLY");
		expect(rig.requests.at(-1)).toEqual([query, hypothesis]);
		await application.services.settings.set("models.default", second);
		await application.services.sessions.selectModel(session.id, first, initial.runtime);
		respond();
		const switched = await application.contextForSession(session.id, query);
		expect(switched.knowledge?.hyde?.model).toEqual(first);
		expect(switched.knowledge?.hyde?.applied).toBe(true);

		respond(); // Automatic preparation.
		fixture.faux.appendResponses([
			fauxAssistantMessage(fauxToolCall("knowledge_search", { query }), { stopReason: "toolUse" }),
		]);
		respond(); // Explicit knowledge tool.
		fixture.faux.appendResponses([
			(context) => {
				expect(JSON.stringify(context)).not.toContain("假设标记");
				return fauxAssistantMessage("根据 actual.md，使用稀疏索引召回。");
			},
		]);
		const run = (await (
			await fixture.request(`/sessions/${session.id}/messages`, {
				method: "POST",
				body: JSON.stringify({ text: query }),
			})
		).json()) as { runId: string };
		const events = await (await fixture.request(`/runs/${run.runId}/events`)).text();
		expect(events).toContain("run.completed");
		expect(events).toContain("knowledge_search");
		expect(events).not.toContain("假设标记");
		expect(observed).toEqual([secondModel.id, firstModel.id, firstModel.id, firstModel.id]);
		respond();
		const memoryTool = await application.services.retrieval.retrieve({ sessionId: session.id, query });
		expect(memoryTool.knowledge?.hyde?.model).toEqual(first);
		expect(memoryTool.knowledge?.hyde?.applied).toBe(true);
		expect(observed.at(-1)).toBe(firstModel.id);
		expect(await application.repositories.knowledge.listChunks(project.id)).toEqual(indexed);
		await fixture.restart();
		expect((await fixture.application.services.knowledge.settings(project)).hyde).toBe("always");
		fixture.faux.setResponses([fauxAssistantMessage(JSON.stringify({ document: hypothesis }))]);
		const restarted = await fixture.application.contextForSession(session.id, query);
		expect(restarted.knowledge?.hyde?.model).toEqual(first);
		expect(restarted.knowledge?.hyde?.applied).toBe(true);
	} finally {
		await rig.close();
	}
}, 45000);

test("rejects oversized hypotheses, cancels generation and retains original-query retrieval on failure", async () => {
	const rig = await createKnowledgeFixture(() => [1, 0], {
		rejectInput: (input) => input.some((text) => text.includes("故障假设标记")),
	});
	const { fixture } = rig;
	try {
		const project = await rig.project("HyDE 降级验证");
		await writeFile(join(project.sourcePath ?? "", "facts.md"), "# 检索\n\n混合检索保留真实资料来源。");
		await fixture.application.services.knowledge.index(project);
		await fixture.application.services.knowledge.configure(project, { mqe: "off", hyde: "always", hydeTokens: 32 });
		const tooLong = await fixture.application.services.knowledge.retrieve(project, "检索", 5, undefined, {
			generateHypothesis: async () => JSON.stringify({ document: "检索可能涉及匹配机制与资料来源。".repeat(60) }),
		});
		expect(tooLong.hyde?.applied).toBe(false);
		expect(tooLong.diagnostics.join()).toContain("Token 上限");
		expect(tooLong.hits[0].text).toContain("真实资料");
		const failed = await fixture.application.services.knowledge.retrieve(project, "检索", 5, undefined, {
			generateHypothesis: async () => {
				throw new Error("credential-secret");
			},
		});
		expect(failed.queries).toEqual(["检索"]);
		expect(failed.hits.length).toBeGreaterThan(0);
		expect(JSON.stringify(failed)).not.toContain("credential-secret");
		await fixture.application.services.knowledge.configure(project, { mqe: "off", hyde: "always" });
		const fault = "检索可能涉及真实资料的匹配机制与来源保留。故障假设标记用于验证失败回退。";
		const scope = fixture.application.services.knowledge.embeddingScope();
		const retried = await fixture.application.services.knowledge.retrieve(project, "检索", 5, undefined, {
			embeddingScope: scope,
			generateHypothesis: async () => JSON.stringify({ document: fault }),
		});
		expect(retried.hits[0].text).toContain("真实资料");
		expect(retried.hyde?.applied).toBe(false);
		expect(retried.diagnostics.join()).toContain("单独重试");
		expect((await scope.embed("检索")).vector).toEqual([1, 0]);
		const session = await fixture.application.createSession({ projectId: project.id });
		await fixture.application.services.knowledge.configure(project, {
			mqe: "off",
			hyde: "always",
			hydeTimeoutMs: 10000,
		});
		let sdkStarted = false;
		fixture.faux.setResponses([
			(context, options) => {
				expect(context.tools?.length ?? 0).toBe(0);
				sdkStarted = true;
				return new Promise((resolve) =>
					options?.signal?.addEventListener(
						"abort",
						() => resolve(fauxAssistantMessage("", { stopReason: "aborted" })),
						{ once: true },
					),
				);
			},
		]);
		let earlyStatus: number | undefined;
		const sending = fixture
			.request(`/sessions/${session.id}/messages`, {
				method: "POST",
				body: JSON.stringify({ text: "检索" }),
			})
			.then(
				(response) => {
					earlyStatus = response.status;
					return response;
				},
				() => {
					earlyStatus = 599;
					return undefined;
				},
			);
		await expect
			.poll(
				() => {
					if (earlyStatus !== undefined)
						throw new Error(`Chat preparation ended before HyDE: HTTP ${earlyStatus}`);
					return sdkStarted;
				},
				{ timeout: 15000 },
			)
			.toBe(true);
		expect((await fixture.request(`/sessions/${session.id}/abort`, { method: "POST" })).status).toBe(202);
		expect((await sending)?.status).toBeGreaterThanOrEqual(400);
		expect(fixture.application.events.getActiveRunId(session.id)).toBeUndefined();
		const controller = new AbortController();
		let started = false;
		const pending = fixture.application.services.knowledge.retrieve(project, "检索", 5, controller.signal, {
			generateHypothesis: async (_prompt, signal) => {
				started = true;
				return new Promise((resolve) => signal.addEventListener("abort", () => resolve(undefined), { once: true }));
			},
		});
		await expect.poll(() => started).toBe(true);
		controller.abort();
		await expect(pending).rejects.toMatchObject({ name: "AbortError" });
	} finally {
		await rig.close();
	}
}, 45000);
