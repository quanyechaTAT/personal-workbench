import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import type {
	ModelProviderDto,
	ModelSettingsDto,
	SaveModelProviderInput,
} from "@earendil-works/workbench-core/contracts";
import type { AgentEvent, RuntimeThinkingLevel } from "@earendil-works/workbench-runtime";
import { afterEach, expect, test, vi } from "vitest";
import { createAssistantFixture } from "./assistant-fixture.ts";
import { startModelServer } from "./fixtures/model-server.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	vi.restoreAllMocks();
});

const localModel = {
	modelId: "deepseek-flash",
	name: "本机 DeepSeek 协议测试",
	enabled: true,
	reasoning: true,
	vision: false,
	contextWindow: 32768,
	maxTokens: 1024,
	thinkingPreset: "deepseek" as const,
};

function providerInput(provider: ModelProviderDto, expectedVersion: number): SaveModelProviderInput {
	return {
		name: provider.name,
		baseUrl: provider.baseUrl,
		api: provider.api,
		enabled: provider.enabled,
		models: provider.models,
		expectedVersion,
	};
}

async function run(
	fixture: Awaited<ReturnType<typeof createAssistantFixture>>,
	sessionId: string,
): Promise<AgentEvent[]> {
	const submitted = await fixture.request(`/sessions/${sessionId}/messages`, {
		method: "POST",
		body: JSON.stringify({ text: "请回答收到消息" }),
	});
	expect(submitted.status).toBe(202);
	const { runId } = (await submitted.json()) as { runId: string };
	const events: AgentEvent[] = [];
	for await (const entry of fixture.application.events.subscribe(runId)) {
		if (entry.event.type !== "stream.reset") events.push(entry.event);
	}
	expect(events.find((event) => event.type === "run.failed")).toBeUndefined();
	expect(events.some((event) => event.type === "message.text.delta" && event.data.delta.includes("收到"))).toBe(true);
	expect(events.some((event) => event.type === "run.completed")).toBe(true);
	expect(events.some((event) => event.type === "run.failed")).toBe(false);
	return events;
}

test.each(["openai-completions", "anthropic-messages", "openai-responses"])(
	"%s: four real Pi thinking payloads, session persistence and removed-model recovery",
	async (api) => {
		const wire = await startModelServer();
		cleanups.push(() => wire.close());
		const fixture = await createAssistantFixture();
		cleanups.push(() => fixture.close());
		const initial = await fixture.application.services.modelSettings.get();
		const saved = await fixture.application.services.modelSettings.save(undefined, {
			name: "本机协议",
			baseUrl: `${wire.origin}/v1`,
			api,
			enabled: true,
			apiKey: "!literal-fixture-key",
			models: [localModel],
			expectedVersion: initial.version,
		});
		const provider = saved.providers.find((entry) => entry.source === "custom")!;
		const model = { provider: provider.id, modelId: localModel.modelId };
		expect(
			(await fixture.application.runtime.listModels()).find((entry) => entry.provider === provider.id)
				?.thinkingLevels,
		).toEqual(["none", "low", "high", "max"]);
		const session = await fixture.application.createSession({ model, thinkingLevel: "none" });
		expect(
			(
				await fixture.request(`/sessions/${session.id}/thinking`, {
					method: "PUT",
					body: JSON.stringify({ level: "medium" }),
				})
			).status,
		).toBe(400);
		for (const level of ["none", "low", "high", "max"] satisfies RuntimeThinkingLevel[]) {
			const response = await fixture.request(`/sessions/${session.id}/thinking`, {
				method: "PUT",
				body: JSON.stringify({ level }),
			});
			expect(response.status).toBe(200);
			await run(fixture, session.id);
			const request = wire.requests.at(-1)!;
			if (api === "openai-completions") {
				expect(request.body.thinking).toEqual({ type: level === "none" ? "disabled" : "enabled" });
				expect(request.body.reasoning_effort).toBe(level === "none" ? undefined : level);
			} else if (api === "anthropic-messages") {
				expect(request.body.thinking).toEqual({ type: level === "none" ? "disabled" : "enabled" });
				expect(request.body.output_config).toEqual(level === "none" ? undefined : { effort: level });
			} else expect(request.body.reasoning).toMatchObject({ effort: level });
			expect(request.authorization ?? request.apiKey).toContain("!literal-fixture-key");
		}
		await fixture.restart();
		expect((await fixture.application.services.sessions.get(session.id)).thinkingLevel).toBe("max");
		await run(fixture, session.id);
		expect((await fixture.application.services.sessions.get(session.id)).runtimeSessionId).toBe(
			session.runtimeSessionId,
		);
		expect((await fixture.application.services.sessions.readTranscript(session.id)).length).toBeGreaterThan(5);
		await fixture.application.services.modelSettings.remove(provider.id, saved.version);
		await fixture.restart();
		// Historical reading must not require the deleted provider or its credential.
		expect((await fixture.application.services.sessions.readTranscript(session.id)).length).toBeGreaterThan(5);
		fixture.faux.setResponses([fauxAssistantMessage("Recovered using an enabled model")]);
		const switched = await fixture.request(`/sessions/${session.id}/model`, {
			method: "PUT",
			body: JSON.stringify({ provider: fixture.model.provider, modelId: fixture.model.id }),
		});
		expect(switched.status).toBe(200);
		expect((await fixture.application.services.sessions.get(session.id)).runtimeSessionId).toBe(
			session.runtimeSessionId,
		);
	},
	60_000,
);

test("only explicitly added models are visible, versions reject stale writes and secrets never enter DTOs or logs", async () => {
	const fixture = await createAssistantFixture();
	cleanups.push(() => fixture.close());
	const current = await fixture.application.services.modelSettings.get();
	const input = {
		name: "Official DeepSeek",
		baseUrl: "https://api.deepseek.com",
		api: "openai-completions",
		enabled: true,
		apiKey: "fixture-secret-value-models",
		models: [localModel, { ...localModel, modelId: "not-added-enabled", enabled: false }],
		expectedVersion: current.version,
	};
	const response = await fixture.request("/models/providers", { method: "POST", body: JSON.stringify(input) });
	expect(response.status).toBe(201);
	const raw = await response.text();
	expect(raw).not.toContain(input.apiKey);
	expect(raw).not.toContain("secretRef");
	const saved = JSON.parse(raw) as ModelSettingsDto;
	const provider = saved.providers.find((entry) => entry.source === "custom")!;
	const visible = (await (await fixture.request("/runtime/models")).json()) as {
		models: Array<{ provider: string; providerName?: string; modelId: string }>;
	};
	expect(visible.models.filter((model) => model.provider === provider.id).map((model) => model.modelId)).toEqual([
		"deepseek-flash",
	]);
	expect(visible.models.find((model) => model.provider === provider.id)?.providerName).toBe("Official DeepSeek");
	expect(
		(
			await fixture.request(`/models/providers/${provider.id}`, {
				method: "PUT",
				body: JSON.stringify({ ...input, expectedVersion: current.version }),
			})
		).status,
	).toBe(409);
	expect(
		(
			await fixture.request(`/models/providers/${provider.id}`, {
				method: "PUT",
				body: JSON.stringify({ ...providerInput(provider, saved.version), baseUrl: "https://untrusted.example" }),
			})
		).status,
	).toBe(400);
	expect(
		(
			await fixture.request("/models/providers", {
				method: "POST",
				body: JSON.stringify({ ...input, expectedVersion: saved.version, maxTokens: input.apiKey }),
			})
		).status,
	).toBe(400);
	const settingsText = await (await fixture.request("/settings")).text();
	expect(settingsText).not.toContain("secretRef");
	expect(settingsText).not.toContain("models.catalog");
	expect((await fixture.application.services.webSearch.getSettings()).configured).toBe(true);
	const disabled = await fixture.application.services.modelSettings.save(provider.id, {
		...providerInput(provider, saved.version),
		enabled: false,
	});
	expect((await fixture.application.runtime.listModels()).some((model) => model.provider === provider.id)).toBe(false);
	expect((await fixture.application.services.webSearch.getSettings()).configured).toBe(false);
	await fixture.application.services.modelSettings.remove(provider.id, disabled.version);
	const credentials = await readFile(join(fixture.root, "data/state/credentials/models.json"), "utf8");
	expect(credentials).not.toContain(input.apiKey);
	const db = await readFile(join(fixture.root, "data/state/workbench.db"));
	expect(db.includes(Buffer.from(input.apiKey))).toBe(false);
	for (const file of await readdir(join(fixture.root, "data/state/logs"))) {
		expect(await readFile(join(fixture.root, "data/state/logs", file), "utf8")).not.toContain(input.apiKey);
	}
});

test("provider discovery reuses a saved credential without saving unselected models or leaking it to another address", async () => {
	const wire = await startModelServer();
	cleanups.push(() => wire.close());
	const fixture = await createAssistantFixture();
	cleanups.push(() => fixture.close());
	const initial = await fixture.application.services.modelSettings.get();
	const saved = await fixture.application.services.modelSettings.save(undefined, {
		name: "远程目录供应商",
		baseUrl: `${wire.origin}/v1`,
		api: "openai-responses",
		enabled: true,
		apiKey: "fixture-model-catalog-secret",
		models: [],
		expectedVersion: initial.version,
	});
	const provider = saved.providers.find((entry) => entry.name === "远程目录供应商")!;
	const input = { providerId: provider.id, baseUrl: provider.baseUrl, api: provider.api };
	const response = await fixture.request("/models/discover", { method: "POST", body: JSON.stringify(input) });
	expect(response.status).toBe(200);
	const text = await response.text();
	expect(text).not.toContain("fixture-model-catalog-secret");
	expect(JSON.parse(text)).toMatchObject({
		endpoint: `${wire.origin}/v1/models`,
		models: [{ modelId: "deepseek-flash", reasoning: true }, { modelId: "not-selected" }],
	});
	expect(wire.catalogRequests[0]?.authorization).toBe("Bearer fixture-model-catalog-secret");
	expect((await fixture.application.services.modelSettings.get()).version).toBe(saved.version);
	expect((await fixture.application.runtime.listModels()).some((entry) => entry.provider === provider.id)).toBe(false);
	for (const changed of [
		{ ...input, baseUrl: "https://other.example/v1" },
		{ ...input, api: "anthropic-messages" },
		{ ...input, modelsUrl: "https://other.example/models" },
	])
		expect(
			(await fixture.request("/models/discover", { method: "POST", body: JSON.stringify(changed) })).status,
		).toBe(400);
	expect(wire.catalogRequests).toHaveLength(1);
	await fixture.application.services.modelSettings.save(provider.id, {
		...providerInput(provider, saved.version),
		models: [localModel],
	});
	const session = await fixture.application.createSession({
		model: { provider: provider.id, modelId: localModel.modelId },
	});
	await run(fixture, session.id);
	expect(wire.requests.at(-1)?.body.model).toBe("deepseek-flash");
	expect((await fixture.application.runtime.listModels()).some((entry) => entry.modelId === "not-selected")).toBe(
		false,
	);
});

test("a reused Pi login discovers Pi models without requiring a public models endpoint", async () => {
	const fixture = await createAssistantFixture();
	cleanups.push(() => fixture.close());
	const catalog = await fixture.application.services.modelSettings.get();
	const provider = catalog.providers.find((entry) => entry.id === fixture.model.provider)!;
	const result = await fixture.application.services.modelSettings.discover({
		providerId: provider.id,
		baseUrl: provider.baseUrl,
		api: provider.api,
	});
	const native = (await fixture.application.services.modelSettings.candidates()).find(
		(entry) => entry.id === provider.id,
	)!;
	expect(result.models.map((entry) => entry.modelId)).toEqual(native.models.map((entry) => entry.modelId));
	expect(result.endpoint).toBe("Pi 模型目录");
	expect(fixture.faux.state.callCount).toBe(0);
	expect((await fixture.application.services.modelSettings.get()).version).toBe(catalog.version);
	await expect(
		fixture.application.services.modelSettings.discover({
			providerId: provider.id,
			baseUrl: "https://other.example/v1",
			api: provider.api,
		}),
	).rejects.toThrow("地址");
});

test("an updated provider is applied to the next request of the same Pi session", async () => {
	const firstWire = await startModelServer();
	const secondWire = await startModelServer();
	cleanups.push(
		() => firstWire.close(),
		() => secondWire.close(),
	);
	const fixture = await createAssistantFixture();
	cleanups.push(() => fixture.close());
	const settings = await fixture.application.services.modelSettings.get();
	const saved = await fixture.application.services.modelSettings.save(undefined, {
		name: "原供应商",
		baseUrl: `${firstWire.origin}/v1`,
		api: "openai-completions",
		enabled: true,
		apiKey: "fixture-original-key",
		models: [localModel],
		expectedVersion: settings.version,
	});
	const provider = saved.providers.find((entry) => entry.name === "原供应商")!;
	const session = await fixture.application.createSession({
		model: { provider: provider.id, modelId: localModel.modelId },
	});
	await run(fixture, session.id);
	await fixture.application.services.modelSettings.save(provider.id, {
		...providerInput(provider, saved.version),
		name: "已更新供应商",
		baseUrl: `${secondWire.origin}/v1`,
		api: "openai-responses",
		apiKey: "fixture-replacement-key",
	});
	await run(fixture, session.id);
	expect(firstWire.requests).toHaveLength(1);
	expect(secondWire.requests.at(-1)).toMatchObject({
		path: "/v1/responses",
		authorization: "Bearer fixture-replacement-key",
		body: { model: localModel.modelId },
	});
	expect((await fixture.application.services.sessions.get(session.id)).runtimeSessionId).toBe(
		session.runtimeSessionId,
	);
	expect(
		(await fixture.application.runtime.listModels()).find((entry) => entry.provider === provider.id)?.providerName,
	).toBe("已更新供应商");
});

test("a quota failure is visible during streaming and after restart even when the model has no text response", async () => {
	const wire = await startModelServer({ modelError: { status: 402, message: "当天调用额度已超限，请等待重置" } });
	cleanups.push(() => wire.close());
	const fixture = await createAssistantFixture();
	cleanups.push(() => fixture.close());
	const settings = await fixture.application.services.modelSettings.get();
	const saved = await fixture.application.services.modelSettings.save(undefined, {
		name: "额度测试供应商",
		baseUrl: `${wire.origin}/v1`,
		api: "openai-responses",
		enabled: true,
		apiKey: "fixture-quota-key",
		models: [localModel],
		expectedVersion: settings.version,
	});
	const provider = saved.providers.find((entry) => entry.name === "额度测试供应商")!;
	const session = await fixture.application.createSession({
		model: { provider: provider.id, modelId: localModel.modelId },
	});
	const response = await fixture.request(`/sessions/${session.id}/messages`, {
		method: "POST",
		body: JSON.stringify({ text: "额度检查" }),
	});
	const { runId } = (await response.json()) as { runId: string };
	const events: AgentEvent[] = [];
	for await (const entry of fixture.application.events.subscribe(runId)) {
		if (entry.event.type !== "stream.reset") events.push(entry.event);
	}
	expect(events.find((entry) => entry.type === "run.failed")?.data).toMatchObject({
		message: "额度测试供应商 请求失败（HTTP 402）：当天调用额度已超限，请等待重置",
	});
	expect(events.some((entry) => entry.type === "run.completed")).toBe(false);
	await fixture.restart();
	const transcript = await fixture.application.services.sessions.readTranscript(session.id);
	expect(transcript.find((entry) => entry.role === "assistant")?.errorMessage).toBe(
		"额度测试供应商 请求失败（HTTP 402）：当天调用额度已超限，请等待重置",
	);
	expect(JSON.stringify(transcript)).not.toContain("fixture-quota-key");
});

test("closing the Gateway cancels an in-flight provider discovery before closing its database", async () => {
	let entered: () => void = () => undefined;
	const requested = new Promise<void>((resolve) => {
		entered = resolve;
	});
	const wire = await startModelServer({ holdCatalog: true, onCatalog: () => entered() });
	cleanups.push(() => wire.close());
	const fixture = await createAssistantFixture();
	cleanups.push(() => fixture.close());
	const request = fixture
		.request("/models/discover", {
			method: "POST",
			body: JSON.stringify({ baseUrl: wire.origin, api: "openai-completions", apiKey: "fixture-cancel-discovery" }),
		})
		.catch((error: unknown) => error);
	await requested;
	await fixture.restart();
	await request;
	await expect.poll(() => wire.cancelledCatalogRequests).toBe(1);
	expect((await fixture.application.services.modelSettings.get()).providers).toHaveLength(1);
});

test("Pi invokes native web_search through services, emits sources, honors filters and persists tool history", async () => {
	const originalFetch = globalThis.fetch;
	const searches: RequestInit[] = [];
	vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
		if (String(url) === "https://api.deepseek.com/anthropic/v1/messages") {
			searches.push(init ?? {});
			return Response.json({
				content: [
					{
						type: "web_search_tool_result",
						content: [
							{
								type: "web_search_result",
								url: "https://api-docs.deepseek.com/guides/thinking_mode/",
								title: "DeepSeek 思考模式",
							},
							{ type: "web_search_result", url: "https://other.example/a", title: "Unselected domain" },
						],
					},
					{
						type: "text",
						text: "This generated answer is not evidence",
						citations: [
							{
								url: "https://api-docs.deepseek.com/guides/thinking_mode/",
								cited_text: "Supports none, low, high, max",
							},
						],
					},
				],
			});
		}
		return originalFetch(url, init);
	});
	const fixture = await createAssistantFixture();
	cleanups.push(() => fixture.close());
	const current = await fixture.application.services.modelSettings.get();
	await fixture.application.services.modelSettings.save(undefined, {
		name: "DeepSeek search",
		baseUrl: "https://api.deepseek.com",
		api: "openai-completions",
		enabled: true,
		apiKey: "fixture-search-key",
		models: [localModel],
		expectedVersion: current.version,
	});
	const session = await fixture.application.createSession({
		model: { provider: fixture.model.provider, modelId: fixture.model.id },
	});
	fixture.faux.setResponses([
		(context) => {
			expect(context.tools?.map((tool) => tool.name)).toContain("web_search");
			return fauxAssistantMessage(
				fauxToolCall(
					"web_search",
					{ query: "DeepSeek thinking levels", allowed_domains: ["api-docs.deepseek.com"] },
					{ id: "search-native" },
				),
				{ stopReason: "toolUse" },
			);
		},
		fauxAssistantMessage("收到搜索来源"),
	]);
	const events = await run(fixture, session.id);
	expect(events.some((event) => event.type === "tool.started" && event.data.toolName === "web_search")).toBe(true);
	const tool = events.find((event) => event.type === "tool.completed" && event.data.toolName === "web_search");
	expect(tool?.data).toMatchObject({ isError: false });
	expect(searches).toHaveLength(1);
	const transcript = await fixture.application.services.sessions.readTranscript(session.id);
	const resultText = transcript
		.filter((message) => message.role === "tool")
		.flatMap((message) => message.content.map((content) => content.text ?? ""))
		.join("");
	expect(resultText).toContain("Supports none, low, high, max");
	expect(resultText).not.toContain("other.example");
	expect(resultText).not.toContain("fixture-search-key");
	expect(resultText).not.toContain("This generated answer");
	const disabled = await fixture.application.services.webSearch.saveSettings({ enabled: false, expectedVersion: 0 });
	expect(disabled.enabled).toBe(false);
	expect(
		(await fixture.request("/search/test", { method: "POST", body: JSON.stringify({ query: "DeepSeek" }) })).status,
	).toBe(409);
	expect(
		(
			await fixture.request("/search/test", {
				method: "POST",
				body: JSON.stringify({ query: "DeepSeek", allowed_domains: ["https://example.com"] }),
			})
		).status,
	).toBe(400);
	await fixture.restart();
	expect((await fixture.application.services.webSearch.getSettings()).enabled).toBe(false);
	expect(JSON.stringify(await fixture.application.services.sessions.readTranscript(session.id))).toContain(
		"DeepSeek 思考模式",
	);
}, 45_000);

test("configuration cannot replace a running model or thinking level, and the active stream remains usable", async () => {
	const fixture = await createAssistantFixture(undefined, { tokensPerSecond: 4 });
	cleanups.push(() => fixture.close());
	const settings = await fixture.application.services.modelSettings.get();
	const provider = settings.providers[0];
	const session = await fixture.application.createSession({});
	fixture.faux.setResponses([fauxAssistantMessage("运行中保持当前模型和思考设置")]);
	const response = await fixture.request(`/sessions/${session.id}/messages`, {
		method: "POST",
		body: JSON.stringify({ text: "请开始运行" }),
	});
	const { runId } = (await response.json()) as { runId: string };
	await expect.poll(async () => (await fixture.application.services.sessions.get(session.id)).status).toBe("running");
	for (const [path, input] of [
		[`/models/providers/${provider.id}`, providerInput(provider, settings.version)],
		[`/sessions/${session.id}/model`, { provider: fixture.model.provider, modelId: fixture.model.id }],
		[`/sessions/${session.id}/thinking`, { level: "low" }],
	] as const)
		expect((await fixture.request(path, { method: "PUT", body: JSON.stringify(input) })).status).toBe(409);
	await fixture.application.services.sessions.abort(session.id);
	for await (const _entry of fixture.application.events.subscribe(runId)) {
		/* Wait for Pi to settle. */
	}
	expect((await fixture.application.services.sessions.get(session.id)).status).toBe("idle");
}, 30_000);

test("new Agent Tasks cannot observe a partially updated shared provider configuration", async () => {
	const fixture = await createAssistantFixture();
	cleanups.push(() => fixture.close());
	const task = await fixture.application.services.tasks.create({ title: "配置边界测试", type: "human" });
	let release: () => void = () => undefined;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const update = fixture.application.configure(async () => gate);
	try {
		await expect(fixture.application.startTask(task.id)).rejects.toThrow("正在运行或更新");
		expect(await fixture.application.services.sessions.list()).toHaveLength(0);
		expect(await fixture.application.services.tasks.listRuns(task.id)).toHaveLength(0);
	} finally {
		release();
		await update;
	}
	fixture.faux.setResponses([fauxAssistantMessage("配置已完成，任务可以独立执行")]);
	const started = await fixture.application.startTask(task.id);
	for await (const _entry of fixture.application.events.subscribe(started.runId)) {
		/* wait for settlement */
	}
	expect((await fixture.application.services.tasks.get(task.id)).status).toBe("review");
});

test("a running session permits creating and streaming a second session; stopping one does not stop the other", async () => {
	const fixture = await createAssistantFixture(undefined, { tokensPerSecond: 4 });
	cleanups.push(() => fixture.close());
	fixture.faux.setResponses([
		fauxAssistantMessage("第一会话的输出与停止操作相互独立，分别保存到自己的历史记录。".repeat(20)),
		fauxAssistantMessage("第二会话的输出与停止操作相互独立，分别保存到自己的历史记录。".repeat(20)),
	]);
	const first = await fixture.application.createSession({ title: "并发一" });
	const firstResponse = await fixture.request(`/sessions/${first.id}/messages`, {
		method: "POST",
		body: JSON.stringify({ text: "第一条消息" }),
	});
	expect(firstResponse.status).toBe(202);
	const firstRun = (await firstResponse.json()) as { runId: string };
	await expect.poll(async () => (await fixture.application.services.sessions.get(first.id)).status).toBe("running");
	const secondResponse = await fixture.request("/sessions", {
		method: "POST",
		body: JSON.stringify({ title: "并发二", profileSlug: "standard" }),
	});
	expect(secondResponse.status).toBe(201);
	const second = (await secondResponse.json()) as { id: string };
	const response = await fixture.request(`/sessions/${second.id}/messages`, {
		method: "POST",
		body: JSON.stringify({ text: "第二条消息" }),
	});
	expect(response.status).toBe(202);
	const secondRun = (await response.json()) as { runId: string };
	await expect.poll(async () => (await fixture.application.services.sessions.get(second.id)).status).toBe("running");
	for (const runId of [firstRun.runId, secondRun.runId]) {
		for await (const entry of fixture.application.events.subscribe(runId)) {
			if (entry.event.type === "message.text.delta") break;
		}
	}
	expect(
		(
			await fixture.request(`/sessions/${first.id}/messages`, {
				method: "POST",
				body: JSON.stringify({ text: "不能重复写同一会话" }),
			})
		).status,
	).toBe(409);
	await fixture.application.events.abort(first.id);
	expect((await fixture.application.services.sessions.get(second.id)).status).toBe("running");
	await fixture.application.events.abort(second.id);
	for (const [id, runId] of [
		[first.id, firstRun.runId],
		[second.id, secondRun.runId],
	]) {
		const events: AgentEvent[] = [];
		for await (const entry of fixture.application.events.subscribe(runId)) {
			if (entry.event.type !== "stream.reset") events.push(entry.event);
		}
		expect(events.every((event) => event.sessionId === id && event.runId === runId)).toBe(true);
		expect(events.some((event) => event.type === "message.text.delta")).toBe(true);
		expect(events.some((event) => event.type === "run.aborted")).toBe(true);
	}
	await fixture.restart();
	const firstHistory = JSON.stringify(await fixture.application.services.sessions.readTranscript(first.id));
	const secondHistory = JSON.stringify(await fixture.application.services.sessions.readTranscript(second.id));
	expect(firstHistory).toContain("第一条消息");
	expect(firstHistory).not.toContain("第二条消息");
	expect(secondHistory).toContain("第二条消息");
	expect(secondHistory).not.toContain("第一条消息");
}, 30_000);
