import type { AgentEvent, ModelThinkingLevel, RuntimeThinkingLevelMap } from "@earendil-works/workbench-runtime";
import { expect, test } from "vitest";
import { createAssistantFixture } from "./assistant-fixture.ts";
import { startModelServer } from "./fixtures/model-server.ts";

test.each(["openai-completions", "anthropic-messages", "openai-responses"])(
	"%s: DeepSeek preset sends every selected effort and preserves max after restart",
	async (api) => {
		const wire = await startModelServer();
		const fixture = await createAssistantFixture();
		try {
			const settings = await fixture.application.services.modelSettings.save(undefined, {
				name: "DeepSeek 预设验收",
				api,
				baseUrl: `${wire.origin}/v1`,
				enabled: true,
				apiKey: "fixture-preset-only",
				expectedVersion: (await fixture.application.services.modelSettings.get()).version,
				models: [
					{
						modelId: "deepseek-flash",
						name: "DeepSeek Flash",
						enabled: true,
						reasoning: true,
						vision: false,
						contextWindow: 32768,
						maxTokens: 1024,
						thinkingPreset: "deepseek",
					},
				],
			});
			const provider = settings.providers.find((entry) => entry.name === "DeepSeek 预设验收")!;
			const session = await fixture.application.createSession({
				model: { provider: provider.id, modelId: "deepseek-flash" },
			});
			for (const level of ["none", "low", "high", "max", "max"] as const) {
				if (wire.requests.length === 4) {
					await fixture.restart();
					expect((await fixture.application.services.sessions.get(session.id)).thinkingLevel).toBe("max");
				} else {
					const selected = await fixture.request(`/sessions/${session.id}/thinking`, {
						method: "PUT",
						body: JSON.stringify({ level }),
					});
					expect(selected.status).toBe(200);
					expect(await selected.json()).toMatchObject({ thinkingLevel: level });
				}
				const submitted = await fixture.request(`/sessions/${session.id}/messages`, {
					method: "POST",
					body: JSON.stringify({ text: `验证默认 ${level}` }),
				});
				expect(submitted.status).toBe(202);
				const { runId } = (await submitted.json()) as { runId: string };
				for await (const entry of fixture.application.events.subscribe(runId)) {
					expect(entry.event.type).not.toBe("run.failed");
				}
				const body = wire.requests.at(-1)!.body;
				if (api === "openai-completions") {
					expect(body.thinking).toEqual({ type: level === "none" ? "disabled" : "enabled" });
					expect(body.reasoning_effort).toBe(level === "none" ? undefined : level);
				} else if (api === "anthropic-messages") {
					expect(body.thinking).toEqual({ type: level === "none" ? "disabled" : "enabled" });
					expect(body.output_config).toEqual(level === "none" ? undefined : { effort: level });
				} else {
					expect(body.reasoning).toEqual(expect.objectContaining({ effort: level }));
				}
			}
		} finally {
			await fixture.close();
			await wire.close();
		}
	},
	60_000,
);

test.each(["openai-completions", "anthropic-messages", "openai-responses"])(
	"%s: custom levels persist, disabled levels disappear and blank efforts are absent from actual Pi HTTP payloads",
	async (api) => {
		const wire = await startModelServer();
		const fixture = await createAssistantFixture();
		try {
			const current = await fixture.application.services.modelSettings.get();
			const thinkingLevelMap: RuntimeThinkingLevelMap = {
				off: "",
				minimal: null,
				low: null,
				medium: null,
				high: "provider-high",
				xhigh: null,
				max: "provider-max",
			};
			const input = {
				name: "映射测试",
				api,
				baseUrl: `${wire.origin}/v1`,
				enabled: true,
				apiKey: "fixture-map-only",
				expectedVersion: current.version,
				models: [
					{
						modelId: "deepseek-flash",
						name: "映射模型",
						enabled: true,
						reasoning: true,
						vision: false,
						contextWindow: 32768,
						maxTokens: 1024,
						thinkingPreset: "deepseek" as const,
						thinkingLevelMap,
					},
				],
			};
			const response = await fixture.request("/models/providers", { method: "POST", body: JSON.stringify(input) });
			expect(response.status).toBe(201);
			const settings = await fixture.application.services.modelSettings.get();
			const provider = settings.providers.find((entry) => entry.name === input.name)!;
			expect(provider.models[0].thinkingLevelMap).toEqual(thinkingLevelMap);
			expect(
				(await fixture.application.runtime.listModels()).find((model) => model.provider === provider.id)
					?.thinkingLevels,
			).toEqual(["none", "high", "max"]);
			const session = await fixture.application.createSession({
				model: { provider: provider.id, modelId: "deepseek-flash" },
			});
			for (const level of ["none", "high", "max"] as const) {
				const selected = await fixture.request(`/sessions/${session.id}/thinking`, {
					method: "PUT",
					body: JSON.stringify({ level }),
				});
				expect(selected.status).toBe(200);
				const submitted = await fixture.request(`/sessions/${session.id}/messages`, {
					method: "POST",
					body: JSON.stringify({ text: `验证 ${level}` }),
				});
				expect(submitted.status).toBe(202);
				const { runId } = (await submitted.json()) as { runId: string };
				const events: AgentEvent[] = [];
				for await (const entry of fixture.application.events.subscribe(runId))
					if (entry.event.type !== "stream.reset") events.push(entry.event);
				expect(events.filter((event) => event.type === "run.failed")).toEqual([]);
				const body = wire.requests.at(-1)!.body;
				const value = level === "none" ? undefined : thinkingLevelMap[level];
				if (api === "openai-completions") expect(body.reasoning_effort).toBe(value);
				else if (api === "anthropic-messages")
					expect(body.output_config).toEqual(value ? { effort: value } : undefined);
				else expect(body.reasoning).toEqual(value ? expect.objectContaining({ effort: value }) : undefined);
			}
			await fixture.restart();
			expect(
				(await fixture.application.services.modelSettings.get()).providers.find((entry) => entry.id === provider.id)
					?.models[0].thinkingLevelMap,
			).toEqual(thinkingLevelMap);
			expect((await fixture.application.services.sessions.get(session.id)).thinkingLevel).toBe("max");
			const disabled = await fixture.request(`/sessions/${session.id}/thinking`, {
				method: "PUT",
				body: JSON.stringify({ level: "low" }),
			});
			expect(disabled.status).toBe(400);
			const noneEnabled = Object.fromEntries(Object.keys(thinkingLevelMap).map((key) => [key, null])) as Record<
				ModelThinkingLevel,
				null
			>;
			const invalid = await fixture.request(`/models/providers/${provider.id}`, {
				method: "PUT",
				body: JSON.stringify({
					...input,
					expectedVersion: settings.version,
					models: [{ ...input.models[0], thinkingLevelMap: noneEnabled }],
				}),
			});
			expect(invalid.status).toBe(400);
		} finally {
			await fixture.close();
			await wire.close();
		}
	},
	60_000,
);
