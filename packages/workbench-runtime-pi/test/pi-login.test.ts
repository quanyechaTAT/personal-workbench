import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { expect, test } from "vitest";
import { PiModelCatalog } from "../src/pi-model-catalog.ts";

test("native interactive login persists credentials through Pi and survives a new runtime", async () => {
	const root = await mkdtemp(join(tmpdir(), "workbench-pi-login-"));
	try {
		const authPath = join(root, "auth.json");
		await writeFile(authPath, "{}");
		const catalog = new PiModelCatalog(await ModelRuntime.create({ authPath, modelsPath: null }));
		await catalog.login("deepseek", "api_key", {
			prompt: async (prompt) => {
				expect(prompt.type).toBe("secret");
				return "fixture-native-persisted-key";
			},
			notify: () => {},
		});
		expect(JSON.parse(await readFile(authPath, "utf8"))).toMatchObject({
			deepseek: { type: "api_key", key: "fixture-native-persisted-key" },
		});
		const restarted = await ModelRuntime.create({ authPath, modelsPath: null });
		expect((await restarted.getAuth("deepseek"))?.auth.apiKey).toBe("fixture-native-persisted-key");
		expect(JSON.stringify(await new PiModelCatalog(restarted).providers())).not.toContain(
			"fixture-native-persisted-key",
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("Pi's native login methods are offered before credentials exist", async () => {
	const root = await mkdtemp(join(tmpdir(), "workbench-pi-login-"));
	try {
		const authPath = join(root, "auth.json");
		await writeFile(authPath, "{}");
		const catalog = new PiModelCatalog(await ModelRuntime.create({ authPath, modelsPath: null }));
		const providers = await catalog.providers();
		expect(providers.find((provider) => provider.id === "openai-codex")).toMatchObject({
			configured: false,
			authMethods: [expect.objectContaining({ type: "oauth" })],
		});
		expect(providers.find((provider) => provider.id === "deepseek")).toMatchObject({
			authMethods: [expect.objectContaining({ type: "api_key" })],
		});
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("Pi login and logout performed outside Workbench update the candidate catalog without restarting", async () => {
	const root = await mkdtemp(join(tmpdir(), "workbench-pi-login-"));
	try {
		const authPath = join(root, "auth.json");
		await writeFile(authPath, "{}");
		const runtime = await ModelRuntime.create({ authPath, modelsPath: null });
		const catalog = new PiModelCatalog(runtime);
		expect((await catalog.providers()).find((provider) => provider.id === "deepseek")?.configured).toBe(false);
		await writeFile(authPath, JSON.stringify({ deepseek: { type: "api_key", key: "fixture-pi-login" } }));
		expect((await catalog.providers()).find((provider) => provider.id === "deepseek")?.configured).toBe(true);
		await writeFile(authPath, "{}");
		expect((await catalog.providers()).find((provider) => provider.id === "deepseek")?.configured).toBe(false);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("the candidate catalog reloads Pi models.json together with the reused login", async () => {
	const root = await mkdtemp(join(tmpdir(), "workbench-pi-login-"));
	try {
		const authPath = join(root, "auth.json");
		const modelsPath = join(root, "models.json");
		await writeFile(authPath, "{}");
		await writeFile(modelsPath, JSON.stringify({ providers: {} }));
		const runtime = await ModelRuntime.create({ authPath, modelsPath });
		const catalog = new PiModelCatalog(runtime);
		await writeFile(
			modelsPath,
			JSON.stringify({
				providers: {
					"pi-local": {
						name: "Pi 本机供应商",
						baseUrl: "http://127.0.0.1:9999/v1",
						api: "openai-completions",
						models: [
							{
								id: "local-model",
								name: "Pi 本机模型",
								reasoning: false,
								input: ["text"],
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
								contextWindow: 32768,
								maxTokens: 1024,
							},
						],
					},
				},
			}),
		);
		await writeFile(authPath, JSON.stringify({ "pi-local": { type: "api_key", key: "fixture-pi-local" } }));
		const provider = (await catalog.providers()).find((entry) => entry.id === "pi-local");
		expect(provider).toMatchObject({
			configured: true,
			models: [expect.objectContaining({ modelId: "local-model" })],
		});
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("reused Pi OAuth remains in Pi auth.json and does not leak through provider DTOs", async () => {
	const root = await mkdtemp(join(tmpdir(), "workbench-pi-login-"));
	try {
		const authPath = join(root, "auth.json");
		await writeFile(authPath, "{}");
		const runtime = await ModelRuntime.create({ authPath, modelsPath: null });
		const catalog = new PiModelCatalog(runtime);
		await writeFile(
			authPath,
			JSON.stringify({
				"openai-codex": {
					type: "oauth",
					access: "fixture-oauth-access",
					refresh: "fixture-oauth-refresh",
					expires: Date.now() + 3600000,
				},
			}),
		);
		const providers = await catalog.providers();
		const provider = providers.find((entry) => entry.id === "openai-codex");
		expect(provider?.configured).toBe(true);
		expect(JSON.stringify(providers)).not.toContain("fixture-oauth");
		await catalog.apply([provider!], new Map());
		const model = catalog.resolve(provider!.id, provider!.models[0]!.modelId);
		expect((await runtime.getAuth(model))?.auth.apiKey).toBe("fixture-oauth-access");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
