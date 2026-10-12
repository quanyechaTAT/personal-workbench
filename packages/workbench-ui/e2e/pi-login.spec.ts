import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { expect, test, type Page } from "@playwright/test";
import { createAssistantFixture } from "../../workbench-server/test/assistant-fixture.ts";

const staticRoot = process.env.WORKBENCH_UI_TEST_STATIC_ROOT ?? fileURLToPath(new URL("../dist", import.meta.url));

for (const providerId of ["openai-codex", "anthropic"] as const) {
	test(`${providerId}: OAuth login supports a manual model ID, editing and restart`, async ({ page }) => {
		const fixture = await createAssistantFixture(staticRoot);
		const errors: string[] = [];
		page.on("pageerror", (error) => errors.push(error.message));
		try {
			const original = fixture.modelRuntime.getProvider(providerId)!;
			const credential = { type: "oauth" as const, access: "fixture-manual-access", refresh: "fixture-manual-refresh", expires: Date.now() + 3_600_000 };
			fixture.modelRuntime.registerNativeProvider({ ...original, refreshModels: undefined, auth: { oauth: {
				name: "Fixture OAuth", refresh: async () => credential, toAuth: async (saved) => ({ apiKey: saved.access }), login: async () => credential,
			} } });
			await page.goto(fixture.address.launchUrl);
			await page.getByRole("link", { name: "设置", exact: true }).click();
			await page.locator(".settings-nav").getByRole("button", { name: /^模型/ }).click();
			await page.getByRole("button", { name: "添加供应商", exact: true }).click();
			await page.getByRole("combobox", { name: "Pi 登录供应商", exact: true }).selectOption(providerId);
			await page.getByRole("button", { name: "登录 Pi", exact: true }).click();
			await expect(page.locator(".provider-detail h3")).toHaveText(original.name);
			await page.getByRole("button", { name: "添加模型", exact: true }).click();
			await expect(page.getByLabel("模型 ID", { exact: true })).toBeEditable();
			await page.getByLabel("模型 ID", { exact: true }).fill("fixture-manual-model");
			await page.getByLabel("显示名称", { exact: true }).fill("手动模型 中文");
			await page.getByLabel("上下文窗口", { exact: true }).fill("65536");
			await page.getByLabel("最大输出 Token", { exact: true }).fill("4096");
			await page.getByRole("button", { name: "加入列表", exact: true }).click();
			await page.getByRole("button", { name: "保存供应商", exact: true }).click();
			await expect(page.getByRole("button", { name: "保存供应商", exact: true })).toBeDisabled();
			await page.locator(".configured-model-row").getByRole("button", { name: "编辑", exact: true }).click();
			await page.getByLabel("显示名称", { exact: true }).fill("修改后的模型");
			await page.getByLabel("上下文窗口", { exact: true }).fill("98304");
			await page.getByRole("button", { name: "加入列表", exact: true }).click();
			await page.getByRole("button", { name: "保存供应商", exact: true }).click();
			await expect(page.getByRole("button", { name: "保存供应商", exact: true })).toBeDisabled();
			await fixture.restart();
			await page.goto(fixture.address.launchUrl);
			await page.getByRole("link", { name: "设置", exact: true }).click();
			await page.locator(".settings-nav").getByRole("button", { name: /^模型/ }).click();
			await page.getByRole("navigation", { name: "模型供应商", exact: true }).getByRole("button", { name: original.name, exact: true }).click();
			await expect(page.getByLabel("API Key", { exact: true })).toBeDisabled();
			await expect(page.getByLabel("Base URL", { exact: true })).toBeDisabled();
			await expect(page.getByLabel("API 格式", { exact: true })).toBeDisabled();
			const saved = (await fixture.application.services.modelSettings.get()).providers.find((entry) => entry.id === providerId)!;
			expect(saved.models[0]).toMatchObject({ modelId: "fixture-manual-model", name: "修改后的模型", contextWindow: 98304 });
			expect(await page.locator("body").textContent()).not.toMatch(/fixture-manual-access|fixture-manual-refresh/);
			expect(errors).toEqual([]);
		} finally { await fixture.close(); }
	});
}

test("configure a Pi-native provider in add-model settings without using the Pi CLI", async ({ page }) => {
	const fixture = await createAssistantFixture(staticRoot);
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	try {
		await page.goto(fixture.address.launchUrl);
		await page.getByRole("link", { name: "设置", exact: true }).click();
		await page.locator(".settings-nav").getByRole("button", { name: /^模型/ }).click();
		await page.getByRole("button", { name: "添加供应商", exact: true }).click();
		await page.getByRole("combobox", { name: "Pi 登录供应商", exact: true }).selectOption("deepseek");
		await page.getByRole("button", { name: "登录 Pi", exact: true }).click();
		await page.getByRole("textbox", { name: "Pi 登录信息", exact: true }).fill("fixture-native-e2e-key");
		await page.getByRole("button", { name: "继续登录", exact: true }).click();
		await expect(page.locator(".provider-detail h3")).toHaveText("DeepSeek");
		await expect(page.getByLabel("API Key", { exact: true })).toBeDisabled();
		await page.getByRole("button", { name: "获取模型列表", exact: true }).click();
		const catalog = (await fixture.application.services.modelSettings.candidates()).find((entry) => entry.id === "deepseek")!;
		const model = catalog.models[0]!;
		await page.getByRole("checkbox", { name: `选择模型 ${model.modelId}`, exact: true }).check();
		await page.getByRole("button", { name: "加入所选模型（1）", exact: true }).click();
		await page.getByRole("button", { name: "保存供应商", exact: true }).click();
		await expect(page.getByRole("button", { name: "保存供应商", exact: true })).toBeDisabled();
		const saved = await fixture.application.services.modelSettings.get();
		expect(saved.providers.find((entry) => entry.id === "deepseek")).toMatchObject({ source: "pi", configured: true, models: [{ modelId: model.modelId }] });
		expect((await fixture.modelRuntime.getAuth("deepseek"))?.auth.apiKey).toBe("fixture-native-e2e-key");
		expect(await page.locator("body").textContent()).not.toContain("fixture-native-e2e-key");
		expect(errors).toEqual([]);
	} finally { await fixture.close(); }
});

test("reuse an existing Pi login and add its model from the native catalog", async ({ page }) => {
	const fixture = await createAssistantFixture(staticRoot);
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	try {
		const original = await fixture.application.services.modelSettings.get();
		const provider = original.providers.find((entry) => entry.id === fixture.model.provider)!;
		await page.goto(fixture.address.launchUrl);
		await page.getByRole("link", { name: "设置", exact: true }).click();
		await page.locator(".settings-nav").getByRole("button", { name: /^模型/ }).click();
		await page.getByRole("button", { name: "刷新 Pi 登录", exact: true }).click();
		await expect(page.getByRole("button", { name: "刷新 Pi 登录", exact: true })).toBeEnabled();
		await page.getByRole("button", { name: "添加供应商", exact: true }).click();
		await expect(page.getByText("复用 Pi 登录", { exact: true })).toHaveCount(0);
		await page.getByRole("combobox", { name: "Pi 登录供应商", exact: true }).selectOption(provider.id);
		await page.getByRole("button", { name: "使用已登录账户", exact: true }).click();
		await expect(page.getByLabel("API Key", { exact: true })).toBeDisabled();
		await expect(page.getByLabel("API Key", { exact: true })).toHaveAttribute("placeholder", "已通过 Pi 配置");
		await page.getByRole("button", { name: "获取模型列表", exact: true }).click();
		await expect(page.getByText(/发现 1 个模型 · Pi 模型目录/)).toBeVisible();
		const choice = page.getByRole("checkbox", { name: `选择模型 ${fixture.model.id}`, exact: true });
		await expect(choice).toBeDisabled();
		await page.getByRole("button", { name: `移除模型 ${provider.models[0]!.name}`, exact: true }).click();
		await expect(choice).toBeEnabled();
		await choice.check();
		await page.getByRole("button", { name: "加入所选模型（1）", exact: true }).click();
		await page.getByRole("button", { name: "保存供应商", exact: true }).click();
		await expect(page.getByRole("button", { name: "保存供应商", exact: true })).toBeDisabled();
		const saved = await fixture.application.services.modelSettings.get();
		expect(saved.providers).toHaveLength(1);
		expect(saved.providers[0]).toMatchObject({ id: provider.id, source: "pi", configured: true, models: [{ modelId: fixture.model.id }] });
		expect(await page.locator("body").textContent()).not.toContain("fixture-only");
		expect(errors).toEqual([]);
	} finally { await fixture.close(); }
});

test("Pi OAuth automatically opens its authorization page and completes through the callback", async ({ page }) => {
	let finishAuthorization: (() => void) | undefined;
	const authorization = createServer((request, response) => {
		response.setHeader("Content-Type", "text/html; charset=utf-8");
		if (request.url === "/callback") {
			finishAuthorization?.();
			response.end("<title>授权完成</title>授权完成");
		} else response.end('<title>Pi fixture 登录</title><a href="/callback">授权账户</a>');
	});
	await new Promise<void>((resolve) => authorization.listen(0, "127.0.0.1", resolve));
	const address = authorization.address();
	if (!address || typeof address === "string") throw new Error("Missing fixture login address");
	const authUrl = `http://127.0.0.1:${address.port}/login`;
	let loginPage: Page | undefined;
	const fixture = await createAssistantFixture(staticRoot, { openLoginUrl: async (url) => {
		loginPage = await page.context().newPage();
		await loginPage.goto(url);
	} });
	try {
		const original = fixture.modelRuntime.getProvider("openai-codex")!;
		const credential = { type: "oauth" as const, access: "fixture-browser-access", refresh: "fixture-browser-refresh", expires: Date.now() + 3_600_000 };
		fixture.modelRuntime.registerNativeProvider({
			...original, id: "browser-login-fixture", name: "Browser login fixture", refreshModels: undefined,
			getModels: () => original.getModels().map((model) => ({ ...model, provider: "browser-login-fixture" })),
			auth: { oauth: {
				name: "Fixture account", refresh: async () => credential, toAuth: async (saved) => ({ apiKey: saved.access }),
				login: async (interaction) => {
					await new Promise<void>((resolve, reject) => {
						finishAuthorization = resolve;
						interaction.signal.addEventListener("abort", () => reject(interaction.signal.reason), { once: true });
						interaction.notify({ type: "auth_url", url: authUrl });
					});
					return credential;
				},
			} },
		});
		await page.goto(fixture.address.launchUrl);
		await page.getByRole("link", { name: "设置", exact: true }).click();
		await page.locator(".settings-nav").getByRole("button", { name: /^模型/ }).click();
		await page.getByRole("button", { name: "添加供应商", exact: true }).click();
		await page.getByRole("combobox", { name: "Pi 登录供应商", exact: true }).selectOption("browser-login-fixture");
		await page.getByRole("button", { name: "登录 Pi", exact: true }).click();
		await expect.poll(() => Boolean(loginPage)).toBe(true);
		await expect(loginPage!).toHaveURL(authUrl);
		await expect(loginPage!).toHaveTitle("Pi fixture 登录");
		await loginPage!.getByRole("link", { name: "授权账户", exact: true }).click();
		await expect(page.locator(".provider-detail h3")).toHaveText("Browser login fixture");
		expect((await fixture.modelRuntime.getAuth("browser-login-fixture"))?.auth.apiKey).toBe(credential.access);
		expect(await page.locator("body").textContent()).not.toContain(credential.access);
	} finally {
		await fixture.close();
		await loginPage?.close();
		await new Promise<void>((resolve, reject) => authorization.close((error) => error ? reject(error) : resolve()));
	}
});

test("token limit fields can be cleared and typed into without an inserted zero", async ({ page }) => {
	const fixture = await createAssistantFixture(staticRoot);
	try {
		await page.goto(fixture.address.launchUrl);
		await page.getByRole("link", { name: "设置", exact: true }).click();
		await page.locator(".settings-nav").getByRole("button", { name: /^模型/ }).click();
		await page.getByRole("button", { name: "添加供应商", exact: true }).click();
		await page.getByLabel("供应商名称", { exact: true }).fill("数字表单 fixture");
		await page.getByLabel("API Key", { exact: true }).fill("fixture-form-key");
		await page.getByRole("button", { name: "添加模型", exact: true }).click();
		await page.getByLabel("模型 ID", { exact: true }).fill("fixture-custom");
		for (const [label, value] of [["上下文窗口", "100000"], ["最大输出 Token", "16384"]] as const) {
			const field = page.getByLabel(label, { exact: true });
			await field.fill("");
			await expect(field).toHaveValue("");
			await field.pressSequentially(value);
			await expect(field).toHaveValue(value);
		}
		await page.getByRole("button", { name: "加入列表", exact: true }).click();
		await page.getByRole("button", { name: "保存供应商", exact: true }).click();
		await expect(page.getByRole("button", { name: "保存供应商", exact: true })).toBeDisabled();
		const saved = await fixture.application.services.modelSettings.get();
		expect(saved.providers.find((entry) => entry.name === "数字表单 fixture")?.models[0]).toMatchObject({ contextWindow: 100000, maxTokens: 16384 });
	} finally { await fixture.close(); }
});
