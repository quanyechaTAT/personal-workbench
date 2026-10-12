import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import type { SessionUsage } from "@earendil-works/workbench-runtime";
import { expect, test } from "@playwright/test";
import { createAssistantFixture } from "../../workbench-server/test/assistant-fixture.ts";

const staticRoot = process.env.WORKBENCH_UI_TEST_STATIC_ROOT ?? fileURLToPath(new URL("../dist", import.meta.url));

test("unassigned chats show live context on hover and manual compact preserves their visible history", async ({ page }) => {
	const fixture = await createAssistantFixture(staticRoot, { modelContextWindow: 128000 });
	try {
		await writeFile(join(fixture.root, "pi-agent", "settings.json"), JSON.stringify({ compaction: { keepRecentTokens: 1 } }));
		const session = await fixture.application.createSession({ profileSlug: "standard" });
		await page.goto(fixture.address.launchUrl);
		await page.goto(`${fixture.address.origin}/chat?session=${session.id}`);
		await expect(page.getByRole("combobox", { name: "项目", exact: true })).toHaveValue("");
		await expect(page.getByRole("combobox", { name: "项目", exact: true })).toContainText("无项目");
		await expect(page.locator("body")).not.toContainText("个人工作区");
		fixture.faux.setResponses([fauxAssistantMessage("已保存任务进度，可继续开发")]);
		const input = page.getByRole("textbox", { name: "消息输入" });
		await input.fill("需要保留的目标：完成项目回归验证。".repeat(20));
		await page.getByRole("button", { name: "发送消息", exact: true }).click();
		await expect(page.locator(".toolbar-state")).toHaveText("就绪");
		await expect(page.locator(".usage-context-label")).toBeVisible();
		await expect(page.getByLabel("本条回复 Token 用量")).toBeVisible();
		await expect(page.getByLabel("本条回复 Token 用量")).toHaveCSS("text-align", "right");
		await expect(page.getByLabel("本条回复 Token 用量")).toHaveCSS("font-size", "11px");
		const state = await (await fixture.request(`/sessions/${session.id}/runtime-state`)).json() as { usage: SessionUsage };
		const tooltip = page.locator(".usage-context-tooltip");
		await expect(tooltip).not.toBeVisible();
		await page.getByRole("button", { name: "上下文窗口用量" }).hover();
		await expect(tooltip).toBeVisible();
		await expect(tooltip).toContainText(`${state.usage.contextTokens?.toLocaleString()} / 128,000`);
		await expect(tooltip).toContainText("达到 80% 时自动压缩");
		await page.setViewportSize({ width: 390, height: 844 });
		await page.getByRole("button", { name: "上下文窗口用量" }).hover();
		const box = await tooltip.boundingBox();
		expect(box?.x).toBeGreaterThanOrEqual(0);
		expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(390);
		await page.setViewportSize({ width: 1440, height: 960 });
		await input.fill("/compact 保留开发目标、验证结果和后续计划");
		fixture.faux.setResponses([fauxAssistantMessage("目标：完成项目回归验证。进度：已记录。"), fauxAssistantMessage("保留最近任务进度。"), fauxAssistantMessage("继续任务。")]);
		await input.press("Enter");
		await expect(page.getByRole("region", { name: "命令结果", exact: true })).toContainText("已压缩上下文");
		await expect(page.locator(".conversation-scroll")).toContainText("需要保留的目标");
		const after = await (await fixture.request(`/sessions/${session.id}/runtime-state`)).json() as { usage: SessionUsage };
		expect(after.usage.contextTokens).toBeGreaterThan(0);
		expect(after.usage.contextTokensSource).toBe("estimated");
		await expect(page.locator(".usage-context-label")).toHaveText(`≈ ${Math.round(100 * after.usage.contextTokens! / 128000)}%`);
		const calls = fixture.faux.state.callCount;
		await page.reload();
		await expect(page.locator(".conversation-scroll")).toContainText("需要保留的目标");
		await expect(page.locator(".usage-context-label")).toHaveAttribute("data-source", "estimated");
		await expect(page.getByLabel("本条回复 Token 用量")).toBeVisible();
		expect(fixture.faux.state.callCount).toBe(calls);
		fixture.faux.setResponses([fauxAssistantMessage("压缩后继续工作")]);
		await input.fill("继续工作");
		await page.getByRole("button", { name: "发送消息", exact: true }).click();
		await expect(page.locator(".conversation-scroll")).toContainText("压缩后继续工作");
		await expect(page.locator(".toolbar-state")).toHaveText("就绪");
		await expect(page.locator(".usage-context-label")).toHaveAttribute("data-source", "reported");
		await expect(page.getByLabel("本条回复 Token 用量")).toHaveCount(2);
	} finally { await fixture.close(); }
});

test("context settings default to 80 percent and persist a changed threshold", async ({ page }) => {
	const fixture = await createAssistantFixture(staticRoot);
	try {
		await page.goto(fixture.address.launchUrl);
		await page.goto(`${fixture.address.origin}/settings?section=general`);
		await expect(page.getByRole("checkbox", { name: "自动压缩上下文" })).toBeChecked();
		const threshold = page.getByRole("combobox", { name: "自动压缩阈值" });
		await expect(threshold).toHaveValue("80");
		await threshold.selectOption("70");
		await expect.poll(async () => (await fixture.application.services.settings.get("context.autoCompactThresholdPercent"))?.value).toBe(70);
		await fixture.restart();
		await page.goto(fixture.address.launchUrl);
		await page.goto(`${fixture.address.origin}/settings?section=general`);
		await expect(threshold).toHaveValue("70");
	} finally { await fixture.close(); }
});

test("a global new chat does not inherit the previously selected project", async ({ page }) => {
	const fixture = await createAssistantFixture(staticRoot);
	try {
		const project = await fixture.application.createProject({ name: "原项目" });
		const previous = await fixture.application.createSession({ projectId: project.id, profileSlug: "standard", title: "原项目对话" });
		await page.goto(fixture.address.launchUrl);
		await page.goto(`${fixture.address.origin}/chat?session=${previous.id}`);
		await expect(page.getByRole("combobox", { name: "项目", exact: true })).toHaveValue(project.id);
		await page.getByRole("button", { name: "新建会话", exact: true }).filter({ visible: true }).click();
		await page.getByRole("combobox", { name: "新会话助手" }).selectOption((await fixture.application.services.profiles.getBySlug("standard")).id);
		await page.getByRole("button", { name: "开始对话", exact: true }).click();
		expect(await fixture.application.services.sessions.list()).toHaveLength(1);
		fixture.faux.setResponses([fauxAssistantMessage("独立会话已开始")]);
		await page.getByRole("textbox", { name: "消息输入" }).fill("独立的新对话");
		await page.getByRole("button", { name: "发送消息", exact: true }).click();
		await expect(page.locator(".toolbar-state")).toHaveText("就绪");
		await expect.poll(async () => (await fixture.application.services.sessions.list()).length).toBe(2);
		const current = (await fixture.application.services.sessions.list()).find((session) => session.title === "独立的新对话");
		expect(current?.projectId).toBeUndefined();
		await expect(page.getByRole("combobox", { name: "项目", exact: true })).toHaveValue("");
	} finally { await fixture.close(); }
});
