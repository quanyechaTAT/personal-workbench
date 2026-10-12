import { Type } from "typebox";
import { Check, Parse } from "typebox/value";
import { expect, test } from "vitest";
import { createAssistantFixture } from "./assistant-fixture.ts";
import { startModelServer } from "./fixtures/model-server.ts";

test("real Pi Responses requests declare object tool schemas and retain action-specific skill validation", async () => {
	const wire = await startModelServer();
	const fixture = await createAssistantFixture();
	try {
		const settings = await fixture.application.services.modelSettings.save(undefined, {
			name: "技能 schema 协议验收",
			api: "openai-responses",
			baseUrl: `${wire.origin}/v1`,
			enabled: true,
			apiKey: "fixture-schema-only",
			expectedVersion: (await fixture.application.services.modelSettings.get()).version,
			models: [
				{
					modelId: "deepseek-flash",
					name: "Schema fixture",
					enabled: true,
					reasoning: false,
					vision: false,
					contextWindow: 32768,
					maxTokens: 1024,
					thinkingPreset: "deepseek",
				},
			],
		});
		const provider = settings.providers.find((value) => value.name === "技能 schema 协议验收")!;
		const project = await fixture.application.createProject({ name: "schema 中文 空格" });
		const session = await fixture.application.createSession({
			projectId: project.id,
			profileSlug: "standard",
			model: { provider: provider.id, modelId: "deepseek-flash" },
		});
		const submitted = await fixture.request(`/sessions/${session.id}/messages`, {
			method: "POST",
			body: JSON.stringify({ text: "确认状态，不调用工具。" }),
		});
		expect(submitted.status).toBe(202);
		const { runId } = Parse(Type.Object({ runId: Type.String() }), await submitted.json());
		for await (const entry of fixture.application.events.subscribe(runId))
			expect(entry.event.type).not.toBe("run.failed");
		expect(wire.requests).toHaveLength(1);
		// DeepSeek rejects a root anyOf without type: object before executing any model turn.
		const body = Parse(
			Type.Object({
				tools: Type.Array(
					Type.Object({ name: Type.String(), parameters: Type.Object({ type: Type.Literal("object") }) }),
				),
			}),
			wire.requests[0].body,
		);
		const skill = body.tools.find((value) => value.name === "skill_manage")!;
		expect(skill).toBeDefined();
		expect(Check(skill.parameters, { action: "view", skillId: "learned-example" })).toBe(true);
		for (const invalid of [
			{ action: "view" },
			{ action: "save" },
			{ action: "view", skillId: "learned-example", skill: {} },
			{ action: "erase", skillId: "learned-example" },
		])
			expect(Check(skill.parameters, invalid)).toBe(false);
	} finally {
		await fixture.close();
		await wire.close();
	}
});
