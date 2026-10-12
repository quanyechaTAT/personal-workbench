import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { fauxAssistantMessage, fauxThinking, fauxText, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { createAssistantFixture } from "../../workbench-server/test/assistant-fixture.ts";

const staticRoot = process.env.WORKBENCH_UI_TEST_STATIC_ROOT ?? fileURLToPath(new URL("../dist", import.meta.url));

test("composer stays in the viewport with many sessions and Chinese input does not submit early", async ({ page }) => {
	const fixture = await createAssistantFixture(staticRoot, { tokensPerSecond: 60 });
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	try {
		for (let index = 0; index < 22; index++) await fixture.application.createSession({ title: `历史会话 ${index + 1}` });
		await page.setViewportSize({ width: 1280, height: 600 });
		await page.goto(fixture.address.launchUrl);
		await page.goto(`${fixture.address.origin}/chat`);
		await expect(page.locator(".session-item")).toHaveCount(22);
		await expect(page.getByRole("combobox", { name: "助手", exact: true })).toHaveValue("");
		await expect(page.getByRole("button", { name: "发送消息" })).toBeDisabled();
		await page.getByRole("combobox", { name: "助手", exact: true }).selectOption((await fixture.application.services.profiles.getBySlug("standard")).id);
		const composer = page.locator(".composer textarea");
		const bounds = await composer.boundingBox();
		expect(bounds).not.toBeNull();
		expect(bounds!.y + bounds!.height).toBeLessThan(580);
		await composer.fill("正在选择中文候选词");
		await composer.dispatchEvent("keydown", { key: "Enter", code: "Enter", isComposing: true });
		await expect(composer).toHaveValue("正在选择中文候选词");
		expect(await fixture.application.services.sessions.list()).toHaveLength(22);
		fixture.faux.setResponses([(context) => {
			expect(context.systemPrompt).toContain("默认使用简体中文");
			return fauxAssistantMessage([fauxThinking("独立的思考内容"), fauxText("中文回答\n".repeat(100))]);
		}]);
		await composer.fill("检查输入和滚动");
		await page.locator(".send-button").click();
		await expect(page.locator(".toolbar-state")).toHaveText("执行中");
		await expect(page.locator(".live-message .message-text")).toContainText("中文回答");
		await expect(page.locator("details.reasoning")).not.toHaveAttribute("open");
		await expect(page.locator(".toolbar-state")).toHaveText("就绪");
		await page.getByRole("button", { name: "会话详情", exact: true }).click();
		await expect(page.locator(".inspector-section .status-pill").first()).toHaveText("就绪");
		await page.getByRole("button", { name: "关闭会话详情" }).click();
		await expect(page.locator(".message-user")).toHaveCount(1);
		await expect(page.locator(".conversation-scroll")).toContainText("中文回答");
		await expect(page.getByLabel("Token 使用统计")).toContainText("1 轮 1 步");
		const scroll = page.locator(".conversation-scroll");
		await scroll.evaluate((element) => { element.scrollTop = 0; element.dispatchEvent(new Event("scroll")); });
		await composer.fill("继续输入不应跳动");
		expect(await scroll.evaluate((element) => element.scrollTop)).toBe(0);
		for (const size of [{ width: 1280, height: 600 }, { width: 760, height: 620 }, { width: 1440, height: 900 }]) {
			await page.setViewportSize(size);
			const box = await composer.boundingBox();
			expect(box!.y + box!.height).toBeLessThan(size.height - 15);
			await expect(page.getByRole("combobox", { name: "权限模式" })).toBeVisible();
		}
		await page.screenshot({ path: "test-results/chat-chinese.png" });
		fixture.faux.setResponses([fauxAssistantMessage("第二轮正常完成")]);
		await composer.fill("再发送一轮，不能重连旧运行");
		await page.getByRole("button", { name: "发送消息" }).click();
		await expect(page.locator(".conversation-scroll")).toContainText("第二轮正常完成");
		await expect(page.locator(".toolbar-state")).toHaveText("就绪");
		await expect(page.locator(".message-user")).toHaveCount(2);
		const project = await fixture.application.createProject({ name: "小窗口项目" });
		await page.goto(`${fixture.address.origin}/projects/${project.id}/chat`);
		await page.setViewportSize({ width: 760, height: 620 });
		const projectInput = await page.locator(".composer textarea").boundingBox();
		expect(projectInput!.x + projectInput!.width).toBeLessThan(760);
		expect(projectInput!.y + projectInput!.height).toBeLessThan(605);
		expect(errors).toEqual([]);
	} finally { await fixture.close(); }
});

test("permission selector persists, hot switching releases approval, and Stop cancels pending commands", async ({ page }) => {
	const fixture = await createAssistantFixture(staticRoot);
	try {
		const session = await fixture.application.createSession({ profileSlug: "standard" });
		await page.goto(fixture.address.launchUrl);
		await page.goto(`${fixture.address.origin}/chat?session=${session.id}`);
		const selector = page.getByRole("combobox", { name: "权限模式" });
		await selector.selectOption("auto");
		await expect.poll(() => fixture.application.services.permissions.getMode(session.id)).toBe("auto");
		await page.reload();
		await expect(selector).toHaveValue("auto");
		page.once("dialog", (dialog) => dialog.dismiss());
		await selector.selectOption("full-access");
		await expect(selector).toHaveValue("auto");
		page.once("dialog", (dialog) => dialog.accept());
		await selector.selectOption("full-access");
		await expect.poll(() => fixture.application.services.permissions.getMode(session.id)).toBe("full-access");
		fixture.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("powershell", { command: "Write-Output full-access-test" }, { id: "full-shell" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("完全访问测试完成"),
		]);
		await page.getByRole("textbox", { name: "消息输入" }).fill("验证完全访问");
		await page.getByRole("button", { name: "发送消息" }).click();
		await expect(page.locator(".conversation-scroll")).toContainText("完全访问测试完成");
		await expect(page.locator(".toolbar-state")).toHaveText("就绪");
		await expect(page.getByRole("button", { name: "批准本次" })).toHaveCount(0);
		await selector.selectOption("ask");
		await expect.poll(() => fixture.application.services.permissions.getMode(session.id)).toBe("ask");
		fixture.faux.setResponses([fauxAssistantMessage(fauxToolCall("powershell", { command: "Write-Output ask-test" }, { id: "ask-shell" }), { stopReason: "toolUse" })]);
		await page.getByRole("textbox", { name: "消息输入" }).fill("等待批准");
		await page.getByRole("button", { name: "发送消息" }).click();
		await expect(page.getByRole("button", { name: "批准本次" })).toBeVisible();
		await expect(selector).toBeEnabled();
		await selector.selectOption("auto");
		await expect.poll(() => fixture.application.services.permissions.getMode(session.id)).toBe("auto");
		await expect(page.getByRole("button", { name: "批准本次" })).toBeVisible();
		expect(await fixture.application.repositories.approvals.listPending()).toHaveLength(1);
		await selector.selectOption("ask");
		await expect.poll(() => fixture.application.services.permissions.getMode(session.id)).toBe("ask");
		await expect(page.getByRole("button", { name: "批准本次" })).toBeVisible();
		await page.getByRole("button", { name: "停止执行" }).click();
		await expect(page.locator(".toolbar-state")).toHaveText("就绪");
		await expect(page.getByRole("button", { name: "批准本次" })).toHaveCount(0);
		fixture.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("powershell", { command: "Write-Output resumed-by-permission" }, { id: "resume-shell" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("切换权限后继续完成"),
		]);
		await page.getByRole("textbox", { name: "消息输入" }).fill("切换权限继续任务");
		await page.getByRole("button", { name: "发送消息" }).click();
		await expect(page.getByRole("button", { name: "批准本次" })).toBeVisible();
		page.once("dialog", (dialog) => dialog.accept());
		await selector.selectOption("full-access");
		await expect(page.locator(".conversation-scroll")).toContainText("切换权限后继续完成");
		await expect(page.locator(".toolbar-state")).toHaveText("就绪");
		expect(await fixture.application.repositories.approvals.listPending()).toEqual([]);
		await fixture.restart();
		await page.goto(fixture.address.launchUrl);
		await page.goto(`${fixture.address.origin}/chat?session=${session.id}`);
		await expect(selector).toHaveValue("full-access");
	} finally { await fixture.close(); }
});
