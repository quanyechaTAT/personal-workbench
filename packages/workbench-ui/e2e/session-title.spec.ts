import { fileURLToPath } from "node:url";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { expect, test } from "@playwright/test";
import { createAssistantFixture } from "../../workbench-server/test/assistant-fixture.ts";

const staticRoot = process.env.WORKBENCH_UI_TEST_STATIC_ROOT ?? fileURLToPath(new URL("../dist", import.meta.url));

for (const width of [1440, 760]) {
	test(`semantic titles and live renaming work at ${width}px without losing input or streaming`, async ({ page }) => {
		let finishReply: () => void = () => undefined;
		let finishTitle: (title: string) => void = () => undefined;
		const replyReady = new Promise<void>((resolve) => { finishReply = resolve; });
		const titleReady = new Promise<string>((resolve) => { finishTitle = resolve; });
		const fixture = await createAssistantFixture(staticRoot, { generateTitle: async () => titleReady });
		const errors: string[] = [];
		page.on("pageerror", (error) => errors.push(error.message));
		try {
			await page.setViewportSize({ width, height: 900 });
			const session = await fixture.application.createSession({ profileSlug: "standard" });
			fixture.faux.setResponses([async () => { await replyReady; return fauxAssistantMessage("继续当前请求，回答正常完成"); }]);
			await page.goto(fixture.address.launchUrl);
			await page.goto(`${fixture.address.origin}/chat?session=${session.id}`);
			const input = page.getByRole("textbox", { name: "消息输入" });
			await input.fill("麻烦帮我检查一下。\n登录后跳转到错误地址，请修复重定向逻辑。");
			await page.getByRole("button", { name: "发送消息", exact: true }).click();
			await expect(page.locator(".toolbar-state")).toHaveText("执行中");
			await input.fill("尚未发送的草稿");
			if (width > 1000) await page.getByRole("button", { name: "会话操作 麻烦帮我检查一下。", exact: true }).click();
			else await page.locator(".compact-session-actions summary").click();
			await page.getByRole("button", { name: "重命名会话", exact: true }).filter({ visible: true }).click();
			const dialog = page.getByRole("dialog", { name: "重命名会话", exact: true });
			await dialog.getByRole("textbox", { name: "会话名称", exact: true }).fill("运行中手动名称");
			finishTitle("修复登录重定向");
			await expect.poll(async () => (await fixture.application.services.sessions.get(session.id)).title).toBe("修复登录重定向");
			await dialog.getByRole("button", { name: "保存名称", exact: true }).click();
			await expect(dialog).toBeHidden();
			await expect(input).toHaveValue("尚未发送的草稿");
			await expect(page.locator(".toolbar-state")).toHaveText("执行中");
			await expect(page.getByRole("button", { name: "停止执行", exact: true })).toBeEnabled();
			await expect.poll(async () => (await fixture.application.services.sessions.get(session.id)).title).toBe("运行中手动名称");
			await input.fill("/name 命令指定名称");
			await input.press("Enter");
			await expect.poll(async () => (await fixture.application.services.sessions.get(session.id)).title).toBe("命令指定名称");
			await expect(page.locator(".toolbar-state")).toHaveText("执行中");
			finishReply();
			await expect(page.locator(".conversation-scroll")).toContainText("回答正常完成");
			await expect(page.locator(".toolbar-state")).toHaveText("就绪");
			await page.reload();
			if (width > 1000) await expect(page.locator(".session-sidebar .session-item.selected")).toContainText("命令指定名称");
			else await expect(page.getByRole("combobox", { name: "切换会话" })).toContainText("命令指定名称");
			expect((await fixture.application.services.sessions.get(session.id)).title).toBe("命令指定名称");
			expect(errors).toEqual([]);
		} finally { finishTitle("修复登录重定向"); finishReply(); await fixture.close(); }
	});
}
