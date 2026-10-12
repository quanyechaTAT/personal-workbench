import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { createAssistantFixture } from "../../workbench-server/test/assistant-fixture.ts";
import { startModelServer } from "../../workbench-server/test/fixtures/model-server.ts";

test("switching an existing conversation back to its configured default changes the actual Pi request", async ({ page }) => {
	const wire = await startModelServer();
	const fixture = await createAssistantFixture(fileURLToPath(new URL("../dist", import.meta.url)));
	try {
		const settings = await fixture.application.services.modelSettings.get();
		const model = { modelId: "first-model", name: "先前模型", enabled: true, reasoning: false, vision: false, contextWindow: 32768, maxTokens: 1024, thinkingPreset: "auto" as const };
		const saved = await fixture.application.services.modelSettings.save(undefined, { name: "测试供应商", baseUrl: `${wire.origin}/v1`, api: "openai-completions", enabled: true, apiKey: "fixture-selection", expectedVersion: settings.version, models: [model, { ...model, modelId: "default-model", name: "默认测试模型" }] });
		const provider = saved.providers.find((entry) => entry.name === "测试供应商")!;
		await fixture.application.services.settings.set("models.default", { provider: provider.id, modelId: "default-model" });
		const session = await fixture.application.createSession({ model: { provider: provider.id, modelId: "first-model" } });
		await page.goto(fixture.address.launchUrl);
		await page.goto(`${fixture.address.origin}/chat?session=${session.id}`);
		await expect(page.getByRole("combobox", { name: "模型", exact: true })).toHaveValue(`${provider.id}/first-model`);
		await page.getByRole("combobox", { name: "模型", exact: true }).selectOption("");
		await page.getByRole("textbox", { name: "消息输入" }).fill("使用默认模型回复");
		await page.getByRole("button", { name: "发送消息" }).click();
		await expect.poll(() => wire.requests.at(-1)?.body.model).toBe("default-model");
		await expect(page.locator(".toolbar-state")).toHaveText("就绪");
		await expect(page.getByRole("combobox", { name: "模型", exact: true }).locator(`option[value="${provider.id}/default-model"]`)).toHaveText("默认测试模型 · 测试供应商");
	} finally { await fixture.close(); await wire.close(); }
});

test("provider quota errors remain readable after a page refresh and a Gateway restart", async ({ page }) => {
	const wire = await startModelServer({ modelError: { status: 402, message: "当天调用额度已超限" } });
	const fixture = await createAssistantFixture(fileURLToPath(new URL("../dist", import.meta.url)));
	try {
		const settings = await fixture.application.services.modelSettings.get();
		const saved = await fixture.application.services.modelSettings.save(undefined, { name: "额度供应商", baseUrl: `${wire.origin}/v1`, api: "openai-responses", enabled: true, apiKey: "fixture-quota-browser", expectedVersion: settings.version, models: [{ modelId: "deepseek-flash", name: "额度测试", enabled: true, reasoning: false, vision: false, contextWindow: 32768, maxTokens: 1024, thinkingPreset: "auto" }] });
		const provider = saved.providers.find((entry) => entry.name === "额度供应商")!;
		const session = await fixture.application.createSession({ model: { provider: provider.id, modelId: "deepseek-flash" } });
		await page.goto(fixture.address.launchUrl);
		await page.goto(`${fixture.address.origin}/chat?session=${session.id}`);
		await page.getByRole("textbox", { name: "消息输入" }).fill("查看调用结果");
		await page.getByRole("button", { name: "发送消息" }).click();
		await expect(page.locator(".conversation-scroll")).toContainText("额度供应商 请求失败（HTTP 402）：当天调用额度已超限");
		await expect(page.locator(".toolbar-state")).toHaveText("就绪");
		await page.reload();
		await expect(page.locator(".message-assistant")).toContainText("当天调用额度已超限");
		await fixture.restart();
		await page.goto(fixture.address.launchUrl);
		await page.goto(`${fixture.address.origin}/chat?session=${session.id}`);
		await expect(page.locator(".message-assistant")).toContainText("额度供应商 请求失败（HTTP 402）");
	} finally { await fixture.close(); await wire.close(); }
});
