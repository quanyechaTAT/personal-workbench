import type { ModelSettingsDto } from "@earendil-works/workbench-core/contracts";
import { expect, test } from "vitest";
import { createAssistantFixture } from "./assistant-fixture.ts";
import { startModelServer } from "./fixtures/model-server.ts";

test("a temporarily unavailable native directory keeps saved definitions without blocking startup", async () => {
	const fixture = await createAssistantFixture();
	try {
		const original = fixture.modelRuntime.getProvider("openai-codex")!;
		const credential = {
			type: "oauth" as const,
			access: "fixture-offline-access",
			refresh: "fixture-offline-refresh",
			expires: Date.now() + 3_600_000,
		};
		const auth = {
			oauth: {
				name: "Fixture OAuth",
				login: async () => credential,
				refresh: async () => credential,
				toAuth: async () => ({ apiKey: credential.access }),
			},
		};
		fixture.modelRuntime.registerNativeProvider({ ...original, refreshModels: undefined, auth });
		await fixture.modelRuntime.login(original.id, "oauth", {
			signal: new AbortController().signal,
			notify: () => undefined,
			prompt: async () => "",
		});
		const imported = await fixture.application.services.modelSettings.importProvider(
			original.id,
			(await fixture.application.services.modelSettings.get()).version,
		);
		const provider = imported.providers.find((entry) => entry.id === original.id)!;
		const model = {
			modelId: "fixture-manual-offline",
			name: "保留模型配置",
			enabled: true,
			reasoning: true,
			vision: false,
			contextWindow: 65536,
			maxTokens: 4096,
			thinkingPreset: "auto" as const,
		};
		await fixture.application.services.modelSettings.save(provider.id, {
			name: provider.name,
			baseUrl: provider.baseUrl,
			api: provider.api,
			enabled: true,
			models: [model],
			expectedVersion: imported.version,
		});
		fixture.modelRuntime.registerNativeProvider({ ...original, refreshModels: undefined, getModels: () => [], auth });
		await fixture.restart();
		expect(
			(await fixture.application.services.modelSettings.get()).providers.find((entry) => entry.id === provider.id),
		).toMatchObject({ supportsCustomModels: false, models: [model] });
		expect((await fixture.application.runtime.listModels()).some((entry) => entry.provider === provider.id)).toBe(
			false,
		);
		fixture.modelRuntime.registerNativeProvider({ ...original, refreshModels: undefined, auth });
		await fixture.restart();
		expect(
			(await fixture.application.runtime.listModels()).find((entry) => entry.modelId === model.modelId)?.available,
		).toBe(true);
	} finally {
		await fixture.close();
	}
});

test.each([
	["openai-codex", "oauth"],
	["anthropic", "oauth"],
	["github-copilot", "oauth"],
	["deepseek", "api_key"],
	["google", "api_key"],
] as const)(
	"%s %s login accepts manual model definitions and preserves native credentials on restart",
	async (providerId, authType) => {
		const fixture = await createAssistantFixture();
		try {
			const original = fixture.modelRuntime.getProvider(providerId)!;
			const credential = {
				type: "oauth" as const,
				access: "fixture-native-access",
				refresh: "fixture-native-refresh",
				expires: Date.now() + 3_600_000,
			};
			if (authType === "oauth")
				fixture.modelRuntime.registerNativeProvider({
					...original,
					refreshModels: undefined,
					auth: {
						...original.auth,
						oauth: {
							name: "Fixture OAuth",
							login: async () => credential,
							refresh: async () => credential,
							toAuth: async (saved) => ({ apiKey: saved.access }),
						},
					},
				});
			await fixture.modelRuntime.login(providerId, authType, {
				signal: new AbortController().signal,
				notify: () => undefined,
				prompt: async () => "fixture-native-key",
			});
			const initial = await fixture.application.services.modelSettings.get();
			const imported = await fixture.application.services.modelSettings.importProvider(providerId, initial.version);
			const provider = imported.providers.find((entry) => entry.id === providerId)!;
			const model = {
				modelId: "codex-fixture-custom",
				name: "自定义 Codex",
				enabled: true,
				reasoning: true,
				vision: true,
				contextWindow: 65536,
				maxTokens: 4096,
				thinkingPreset: "auto" as const,
			};
			const input = {
				name: provider.name,
				baseUrl: provider.baseUrl,
				api: provider.api,
				enabled: true,
				models: [model],
				expectedVersion: imported.version,
			};
			const response = await fixture.request(`/models/providers/${providerId}`, {
				method: "PUT",
				body: JSON.stringify(input),
			});
			expect(response.status).toBe(200);
			const saved = (await response.json()) as ModelSettingsDto;
			expect(saved.providers.find((entry) => entry.id === provider.id)).toMatchObject({
				supportsCustomModels: true,
				models: [model],
			});
			expect(
				(await fixture.application.runtime.listModels()).find((entry) => entry.modelId === model.modelId),
			).toMatchObject({ provider: providerId, name: model.name, available: true, contextWindow: 65536 });
			for (const change of [
				{ baseUrl: "https://example.com" },
				{ api: "different-api" },
				{ apiKey: "replacement-key" },
			]) {
				const rejected = await fixture.request(`/models/providers/${providerId}`, {
					method: "PUT",
					body: JSON.stringify({ ...input, expectedVersion: saved.version, ...change }),
				});
				expect(rejected.status).toBe(400);
			}
			const session = await fixture.application.createSession({
				model: { provider: providerId, modelId: model.modelId },
			});
			await fixture.restart();
			expect(
				(await fixture.application.services.modelSettings.get()).providers.find((entry) => entry.id === provider.id)
					?.models,
			).toEqual([model]);
			expect((await fixture.application.services.sessions.get(session.id)).runtimeSessionId).toBe(
				session.runtimeSessionId,
			);
			expect((await fixture.modelRuntime.getAuth(providerId))?.auth.apiKey).toBe(
				authType === "oauth" ? credential.access : "fixture-native-key",
			);
			expect(JSON.stringify(saved)).not.toMatch(/fixture-native-access|fixture-native-refresh|fixture-native-key/);
		} finally {
			await fixture.close();
		}
	},
);

test("a custom Codex ID reaches the real Pi SDK protocol and resumes the same Pi session", async () => {
	const wire = await startModelServer();
	const fixture = await createAssistantFixture();
	try {
		const original = fixture.modelRuntime.getProvider("openai-codex")!;
		const token = `fixture.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture-account" } })).toString("base64url")}.fixture`;
		const credential = {
			type: "oauth" as const,
			access: token,
			refresh: "fixture-refresh",
			expires: Date.now() + 3_600_000,
		};
		fixture.modelRuntime.registerNativeProvider({
			...original,
			refreshModels: undefined,
			// Keep the real Codex serializer/stream parser, using controlled HTTP responses.
			streamSimple: (model, context, options) =>
				original.streamSimple(model, context, { ...options, transport: "sse" }),
			auth: {
				oauth: {
					name: "Fixture Codex",
					login: async () => credential,
					refresh: async () => credential,
					toAuth: async (saved) => ({ apiKey: saved.access, baseUrl: `${wire.origin}/backend-api` }),
				},
			},
		});
		await fixture.modelRuntime.login("openai-codex", "oauth", {
			signal: new AbortController().signal,
			notify: () => undefined,
			prompt: async () => "",
		});
		const imported = await fixture.application.services.modelSettings.importProvider(
			"openai-codex",
			(await fixture.application.services.modelSettings.get()).version,
		);
		const provider = imported.providers.find((entry) => entry.id === "openai-codex")!;
		const model = {
			modelId: "codex-fixture-custom",
			name: "Codex 协议测试",
			enabled: true,
			reasoning: true,
			vision: true,
			contextWindow: 65536,
			maxTokens: 4096,
			thinkingPreset: "auto" as const,
		};
		await fixture.application.services.modelSettings.save(provider.id, {
			name: provider.name,
			baseUrl: provider.baseUrl,
			api: provider.api,
			enabled: true,
			models: [model],
			expectedVersion: imported.version,
		});
		const session = await fixture.application.createSession({
			model: { provider: provider.id, modelId: model.modelId },
			thinkingLevel: "low",
		});
		for (let turn = 0; turn < 2; turn++) {
			if (turn) await fixture.restart();
			const submitted = await fixture.request(`/sessions/${session.id}/messages`, {
				method: "POST",
				body: JSON.stringify({ text: "请回答收到消息" }),
			});
			expect(submitted.status).toBe(202);
			const { runId } = (await submitted.json()) as { runId: string };
			const outcomes: string[] = [];
			for await (const entry of fixture.application.events.subscribe(runId)) {
				if (entry.event.type === "run.failed" || entry.event.type === "run.completed")
					outcomes.push(entry.event.type);
			}
			expect(outcomes).toEqual(["run.completed"]);
			expect(wire.requests.at(-1)).toMatchObject({
				path: "/backend-api/codex/responses",
				authorization: `Bearer ${token}`,
				body: { model: model.modelId, reasoning: { effort: "low" }, store: false },
			});
			expect((await fixture.application.services.sessions.get(session.id)).runtimeSessionId).toBe(
				session.runtimeSessionId,
			);
		}
		expect(wire.requests).toHaveLength(2);
	} finally {
		await fixture.close();
		await wire.close();
	}
}, 60_000);
