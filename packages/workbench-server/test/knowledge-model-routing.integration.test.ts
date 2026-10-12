import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import type { KnowledgeSearchResult } from "@earendil-works/workbench-core";
import { expect, test } from "vitest";
import { createKnowledgeFixture } from "./knowledge-rag-fixture.ts";

test("MQE follows the conversation LLM across selection and tool calls; standalone retrieval uses the system default", async () => {
	const rig = await createKnowledgeFixture();
	const { fixture } = rig;
	try {
		const { application } = fixture;
		const original = fixture.model;
		const alternate = { ...original, id: "conversation-llm", name: "Conversation LLM" };
		fixture.modelRuntime.registerProvider(original.provider, {
			api: original.api,
			baseUrl: original.baseUrl,
			models: [original, alternate],
		});
		const catalog = application.runtime.modelCatalog;
		if (!catalog) throw new Error("Pi model catalog is unavailable");
		const provider = (await catalog.providers()).find((entry) => entry.id === original.provider);
		if (!provider) throw new Error("Faux provider is unavailable");
		await catalog.apply([provider], new Map());
		const first = { provider: original.provider, modelId: original.id };
		const second = { provider: alternate.provider, modelId: alternate.id };
		await application.services.settings.set("models.default", first);
		const project = await rig.project("对话模型路由验证");
		await writeFile(join(project.sourcePath ?? "", "facts.md"), "# Qwen3\n\nQwen3 使用 2025 年数据。");
		await application.services.knowledge.configure(project, { mqe: "always", mqeTimeoutMs: 5000 });
		await application.services.knowledge.index(project);
		const session = await application.createSession({ projectId: project.id, model: second });
		const observed: Array<{ model: string; tools: number; prompt: string }> = [];
		const rewrite = (expectedQuery = "Qwen3 数据") => {
			fixture.faux.appendResponses([
				(context, _options, _state, model) => {
					observed.push({
						model: model.id,
						tools: context.tools?.length ?? 0,
						prompt: context.systemPrompt ?? "",
					});
					return fauxAssistantMessage(JSON.stringify({ queries: [`关于 ${expectedQuery} 的资料`] }));
				},
			]);
		};
		rewrite();
		const initial = await application.contextForSession(session.id, "Qwen3 数据");
		expect(initial.knowledge?.mqe.applied).toBe(true);
		expect(observed.at(-1)?.model).toBe(alternate.id);

		// Changing the global default must not replace the LLM already selected for this conversation.
		await application.services.settings.set("models.default", second);
		await application.services.sessions.selectModel(session.id, first, initial.runtime);
		rewrite();
		const switched = await application.contextForSession(session.id, "Qwen3 数据");
		expect(switched.knowledge?.mqe.applied).toBe(true);
		expect(observed.at(-1)?.model).toBe(original.id);

		// Drive the actual HTTP chat -> Pi tool -> isolated Pi completion path.
		rewrite();
		fixture.faux.appendResponses([
			fauxAssistantMessage(fauxToolCall("knowledge_search", { query: "Qwen3 数据" }), { stopReason: "toolUse" }),
		]);
		rewrite();
		fixture.faux.appendResponses([fauxAssistantMessage("根据项目资料，Qwen3 使用 2025 年数据。")]);
		const run = (await (
			await fixture.request(`/sessions/${session.id}/messages`, {
				method: "POST",
				body: JSON.stringify({ text: "Qwen3 数据" }),
			})
		).json()) as { runId: string };
		const events = await (await fixture.request(`/runs/${run.runId}/events`)).text();
		expect(events).toContain("run.completed");
		expect(events).toContain("knowledge_search");
		expect(observed.map((entry) => entry.model)).toEqual([alternate.id, original.id, original.id, original.id]);
		expect(observed.every((entry) => entry.tools === 0 && entry.prompt.includes("不得回答问题"))).toBe(true);

		rewrite();
		const standalone = (await (
			await fixture.request(`/projects/${project.id}/knowledge/retrieve?q=${encodeURIComponent("Qwen3 数据")}`)
		).json()) as KnowledgeSearchResult;
		expect(standalone.mqe.applied).toBe(true);
		expect(observed.at(-1)?.model).toBe(alternate.id);
		expect(rig.requests.at(-1)).toEqual(["Qwen3 数据", "关于 Qwen3 数据 的资料"]);
	} finally {
		await rig.close();
	}
}, 45_000);
