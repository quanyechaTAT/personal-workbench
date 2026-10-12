import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { createAssistantFixture } from "../../workbench-server/test/assistant-fixture.ts";

test("create a session during streaming, run both, switch between them and stop each independently", async ({ page }) => {
const fixture = await createAssistantFixture(process.env.WORKBENCH_UI_TEST_STATIC_ROOT ?? fileURLToPath(new URL("../dist", import.meta.url)), { tokensPerSecond: 6 });
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	try {
		fixture.faux.setResponses([
			fauxAssistantMessage("第一会话输出。".repeat(120)),
			fauxAssistantMessage("第二会话输出。".repeat(120)),
		]);
		const first = await fixture.application.createSession({ title: "并发会话一" });
		const profile = await fixture.application.services.profiles.getBySlug("standard");
		await page.goto(fixture.address.launchUrl);
		await page.goto(`${fixture.address.origin}/chat?session=${first.id}`);
		await page.getByRole("textbox", { name: "消息输入" }).fill("第一条并发请求");
		await page.getByRole("button", { name: "发送消息" }).click();
		await expect(page.locator(".live-message .message-text")).toContainText("第一会话输出");
		await page.waitForTimeout(2_300);
		await page.getByRole("button", { name: "新建会话", exact: true }).click();
		await page.getByRole("combobox", { name: "新会话助手" }).selectOption(profile.id);
		await page.getByRole("button", { name: "开始对话", exact: true }).click();
		await expect(page.getByRole("dialog", { name: "新建会话" })).toHaveCount(0);
		expect(new URL(page.url()).searchParams.get("run")).toBeNull();
		await expect(page.locator(".conversation-scroll")).not.toContainText("第一会话输出");
		await page.waitForTimeout(2_300);
		await expect(page.locator(".conversation-scroll")).not.toContainText("第一会话输出");
		await page.getByRole("textbox", { name: "消息输入" }).fill("第二条并发请求");
		await page.getByRole("button", { name: "发送消息" }).click();
		await expect(page.locator(".live-message .message-text")).toContainText("第二会话输出");
		const secondId = new URL(page.url()).searchParams.get("session")!;
		await expect(page.locator(".session-item .status-dot.working")).toHaveCount(2);
		await page.getByRole("button", { name: /^并发会话一/ }).click();
		await expect(page.locator(".live-message .message-text")).toContainText("第一会话输出");
		await expect(page.locator(".conversation-scroll")).not.toContainText("第二会话输出");
		await page.getByRole("button", { name: "停止执行", exact: true }).click();
		await expect(page.locator(".toolbar-state")).toHaveText("就绪");
		expect((await fixture.application.services.sessions.get(secondId)).status).toBe("running");
		await page.getByRole("button", { name: /^第二条并发请求/ }).click();
		await expect(page.locator(".toolbar-state")).toHaveText("执行中");
		await expect(page.locator(".live-message .message-text")).toContainText("第二会话输出");
		await page.screenshot({ path: "test-results/concurrent-sessions.png" });
		await page.getByRole("button", { name: "停止执行", exact: true }).click();
		await expect(page.locator(".toolbar-state")).toHaveText("就绪");
		await fixture.restart();
		await page.goto(fixture.address.launchUrl);
		await page.goto(`${fixture.address.origin}/chat?session=${first.id}`);
		await expect(page.locator(".conversation-scroll")).toContainText("第一条并发请求");
		await expect(page.locator(".conversation-scroll")).not.toContainText("第二条并发请求");
		await page.getByRole("button", { name: /^第二条并发请求/ }).click();
		await expect(page.locator(".conversation-scroll")).toContainText("第二条并发请求");
		expect(errors).toEqual([]);
	} finally { await fixture.close(); }
});
