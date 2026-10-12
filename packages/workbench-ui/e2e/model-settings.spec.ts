import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { createAssistantFixture } from "../../workbench-server/test/assistant-fixture.ts";
import { startModelServer } from "../../workbench-server/test/fixtures/model-server.ts";

const staticRoot = process.env.WORKBENCH_UI_TEST_STATIC_ROOT ?? fileURLToPath(new URL("../dist", import.meta.url));

test("configure providers in Chinese, select four thinking levels, hide disabled models and resume after restart", async ({ page }) => {
	const wire = await startModelServer();
	const fixture = await createAssistantFixture(staticRoot);
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	try {
		await page.goto(fixture.address.launchUrl);
		await page.getByRole("link", { name: "设置", exact: true }).click();
		await page.locator(".settings-nav").getByRole("button", { name: /^模型/ }).click();
		await page.getByRole("button", { name: "添加供应商", exact: true }).click();
		await page.getByRole("button", { name: "添加模型", exact: true }).click();
		await expect(page.getByLabel("思考参数", { exact: true })).toHaveValue("deepseek");
		await page.getByRole("button", { name: "取消", exact: true }).click();
		await page.getByLabel("供应商名称", { exact: true }).fill("本机 DeepSeek");
		await page.getByLabel("Base URL", { exact: true }).fill(`${wire.origin}/v1`);
		await page.getByLabel("API 格式", { exact: true }).selectOption("openai-completions");
		await page.getByLabel("API Key", { exact: true }).fill("fixture-browser-secret");
		await page.getByRole("button", { name: "添加模型", exact: true }).click();
		await page.getByLabel("模型 ID", { exact: true }).fill("deepseek-flash");
		await page.getByLabel("显示名称", { exact: true }).fill("DeepSeek 测试");
		await page.getByLabel("思考参数", { exact: true }).selectOption("deepseek");
		await page.getByRole("button", { name: "加入列表", exact: true }).click();
		await page.getByRole("button", { name: "保存供应商", exact: true }).click();
		await expect(page.getByLabel("API Key", { exact: true })).toHaveValue("");
		await expect(page.getByLabel("API Key", { exact: true })).toHaveAttribute("placeholder", "已配置，留空保留原凭证");
		await page.screenshot({ path: "test-results/model-provider-settings.png" });
		const configured = await fixture.application.services.modelSettings.get();
		const provider = configured.providers.find((entry) => entry.name === "本机 DeepSeek")!;
		await page.getByRole("combobox", { name: "默认模型", exact: true }).selectOption(`${provider.id}/deepseek-flash`);
		await expect.poll(async () => (await fixture.application.services.settings.get("models.default"))?.value).toEqual({ provider: provider.id, modelId: "deepseek-flash" });
		await page.getByRole("link", { name: "对话", exact: true }).first().click();
		await page.getByRole("combobox", { name: "助手", exact: true }).selectOption((await fixture.application.services.profiles.getBySlug("standard")).id);
		await page.getByRole("combobox", { name: "模型", exact: true }).selectOption(`${provider.id}/deepseek-flash`);
		const thinking = page.getByRole("combobox", { name: "思考强度", exact: true });
		await expect(thinking.locator("option")).toHaveCount(4);
		expect(await thinking.locator("option").evaluateAll((items) => items.map((item) => item.getAttribute("value")))).toEqual(["none", "low", "high", "max"]);
		for (const level of ["none", "low", "high", "max"]) {
			await thinking.selectOption(level);
			await page.getByRole("textbox", { name: "消息输入" }).fill(`测试 ${level}`);
			await expect(page.getByRole("button", { name: "发送消息" })).toBeEnabled();
			await page.getByRole("button", { name: "发送消息" }).click();
			await expect.poll(() => wire.requests.length).toBeGreaterThan(["none", "low", "high", "max"].indexOf(level));
			await expect(page.locator(".toolbar-state")).toHaveText("就绪");
			expect(wire.requests.at(-1)?.body.thinking).toEqual({ type: level === "none" ? "disabled" : "enabled" });
			expect(wire.requests.at(-1)?.body.reasoning_effort).toBe(level === "none" ? undefined : level);
		}
		const sessionId = new URL(page.url()).searchParams.get("session")!;
		await fixture.restart();
		await page.goto(fixture.address.launchUrl);
		await page.goto(`${fixture.address.origin}/chat?session=${sessionId}`);
		await expect(thinking).toHaveValue("max");
		await expect(page.locator(".message-assistant")).toHaveCount(4);
		await page.screenshot({ path: "test-results/models-thinking.png" });
		await page.getByRole("link", { name: "设置", exact: true }).click();
		await page.locator(".settings-nav").getByRole("button", { name: /^模型/ }).click();
		await page.getByRole("navigation", { name: "模型供应商" }).getByRole("button", { name: "本机 DeepSeek" }).click();
		await page.getByRole("checkbox", { name: "启用模型 DeepSeek 测试", exact: true }).uncheck();
		await page.getByRole("button", { name: "保存供应商", exact: true }).click();
		await expect(page.getByRole("button", { name: "保存供应商", exact: true })).toBeDisabled();
		await page.getByRole("link", { name: "对话", exact: true }).first().click();
		await expect(page.getByRole("combobox", { name: "模型", exact: true }).locator(`option[value="${provider.id}/deepseek-flash"]`)).toHaveCount(0);
		const notice = page.locator(".chat-model-notice");
		await expect(notice).toBeVisible();
		expect((await notice.boundingBox())!.height).toBeLessThan(90);
		await page.screenshot({ path: "test-results/model-unavailable.png" });
		expect(errors).toEqual([]);
	} finally {
		await fixture.close();
		await wire.close();
	}
});

test("native search sources appear in the streamed tool card and remain readable after restart", async ({ page }) => {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async (url, init) => {
		if (String(url) === "https://api.deepseek.com/anthropic/v1/messages") return Response.json({ content: [
			{ type: "web_search_tool_result", content: [{ type: "web_search_result", title: "DeepSeek 官方思考文档", url: "https://api-docs.deepseek.com/guides/thinking_mode/" }] },
			{ type: "text", text: "Generated prose is not search evidence", citations: [{ url: "https://api-docs.deepseek.com/guides/thinking_mode/", cited_text: "none / low / high / max" }] },
		] });
		return originalFetch(url, init);
	};
	const fixture = await createAssistantFixture(staticRoot);
	try {
		const settings = await fixture.application.services.modelSettings.get();
		await fixture.application.services.modelSettings.save(undefined, { name: "DeepSeek 官方搜索", baseUrl: "https://api.deepseek.com", api: "openai-completions", enabled: true, apiKey: "fixture-browser-search", expectedVersion: settings.version, models: [{ modelId: "deepseek-flash", name: "DeepSeek", enabled: true, reasoning: true, vision: false, contextWindow: 32768, maxTokens: 1024, thinkingPreset: "deepseek" }] });
		const session = await fixture.application.createSession({ title: "原生联网搜索", model: { provider: fixture.model.provider, modelId: fixture.model.id } });
		fixture.faux.setResponses([fauxAssistantMessage(fauxToolCall("web_search", { query: "DeepSeek 官方思考文档" }, { id: "native-web-search" }), { stopReason: "toolUse" }), fauxAssistantMessage("已找到官方文档")]);
		await page.goto(fixture.address.launchUrl);
		await page.goto(`${fixture.address.origin}/chat?session=${session.id}`);
		await page.getByRole("textbox", { name: "消息输入" }).fill("搜索最新官方说明");
		await page.getByRole("button", { name: "发送消息" }).click();
		await expect(page.locator(".toolbar-state")).toHaveText("就绪");
		const result = page.getByRole("link", { name: "1. DeepSeek 官方思考文档", exact: true });
		await expect(result).toHaveAttribute("href", "https://api-docs.deepseek.com/guides/thinking_mode/");
		await expect(page.getByRole("region", { name: "搜索来源" })).toContainText("none / low / high / max");
		expect(await page.getByRole("region", { name: "搜索来源" }).evaluate((element) => element.ownerDocument.defaultView?.getComputedStyle(element).position)).toBe("static");
		await fixture.restart();
		await page.goto(fixture.address.launchUrl);
		await page.goto(`${fixture.address.origin}/chat?session=${session.id}`);
		await expect(result).toBeVisible();
		await page.getByRole("link", { name: "设置", exact: true }).click();
		await page.locator(".settings-nav").getByRole("button", { name: /^联网搜索/ }).click();
		await expect(page.getByText("已配置", { exact: true })).toBeVisible();
		await page.screenshot({ path: "test-results/search-settings.png" });
	} finally {
		await fixture.close();
		globalThis.fetch = originalFetch;
	}
});

test("discover provider models, explicitly add one, and use its real ID after saving and restarting", async ({ page }) => {
	const wire = await startModelServer();
	const fixture = await createAssistantFixture(staticRoot);
	try {
		await page.goto(fixture.address.launchUrl);
		await page.getByRole("link", { name: "设置", exact: true }).click();
		await page.locator(".settings-nav").getByRole("button", { name: /^模型/ }).click();
		await page.getByRole("button", { name: "添加供应商", exact: true }).click();
		await page.getByLabel("供应商名称", { exact: true }).fill("发现模型供应商");
		await page.getByLabel("Base URL", { exact: true }).fill(`${wire.origin}/v1`);
		await page.getByLabel("API Key", { exact: true }).fill("fixture-discovery-browser-key");
		await page.getByRole("button", { name: "获取模型列表", exact: true }).click();
		await expect(page.getByRole("checkbox", { name: "选择模型 deepseek-flash", exact: true })).toBeVisible();
		await page.getByRole("checkbox", { name: "选择模型 deepseek-flash", exact: true }).check();
		await expect(page.getByRole("checkbox", { name: "选择模型 not-selected", exact: true })).not.toBeChecked();
		await page.getByRole("button", { name: "加入所选模型（1）", exact: true }).click();
		await expect(page.getByRole("checkbox", { name: "启用模型 DeepSeek Flash", exact: true })).toBeChecked();
		await page.getByRole("button", { name: "保存供应商", exact: true }).click();
		await expect(page.getByLabel("API Key", { exact: true })).toHaveValue("");
		await page.getByRole("button", { name: "获取模型列表", exact: true }).click();
		await expect(page.getByRole("checkbox", { name: "选择模型 deepseek-flash", exact: true })).toBeDisabled();
		expect(wire.catalogRequests).toHaveLength(2);
		expect(wire.catalogRequests[1]?.authorization).toBe("Bearer fixture-discovery-browser-key");
		const settings = await fixture.application.services.modelSettings.get();
		const provider = settings.providers.find((entry) => entry.name === "发现模型供应商")!;
		expect(provider.models.map((model) => model.modelId)).toEqual(["deepseek-flash"]);
		await page.getByRole("link", { name: "对话", exact: true }).first().click();
		const selector = page.getByRole("combobox", { name: "模型", exact: true });
		await page.getByRole("combobox", { name: "助手", exact: true }).selectOption((await fixture.application.services.profiles.getBySlug("standard")).id);
		await expect(selector.locator(`option[value="${provider.id}/deepseek-flash"]`)).toHaveText("DeepSeek Flash · 发现模型供应商");
		await expect(selector.locator(`option[value="${provider.id}/not-selected"]`)).toHaveCount(0);
		await selector.selectOption(`${provider.id}/deepseek-flash`);
		await page.getByRole("textbox", { name: "消息输入" }).fill("使用发现的模型");
		await page.getByRole("button", { name: "发送消息" }).click();
		await expect.poll(() => wire.requests.at(-1)?.body.model).toBe("deepseek-flash");
		await expect(page.locator(".toolbar-state")).toHaveText("就绪");
		const id = new URL(page.url()).searchParams.get("session")!;
		await fixture.restart();
		await page.goto(fixture.address.launchUrl);
		await page.goto(`${fixture.address.origin}/chat?session=${id}`);
		await expect(selector).toHaveValue(`${provider.id}/deepseek-flash`);
		await page.getByRole("textbox", { name: "消息输入" }).fill("重启后继续");
		await page.getByRole("button", { name: "发送消息" }).click();
		await expect.poll(() => wire.requests.length).toBe(2);
		await expect(page.locator(".toolbar-state")).toHaveText("就绪");
		await page.screenshot({ path: "test-results/model-discovery.png" });
	} finally { await fixture.close(); await wire.close(); }
});
