import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { createAssistantFixture } from "../../workbench-server/test/assistant-fixture.ts";

const staticRoot = process.env.WORKBENCH_UI_TEST_STATIC_ROOT ?? fileURLToPath(new URL("../dist", import.meta.url));

test("project folders and ordinary chats stay separated through archive and restart", async ({ page }) => {
	const fixture = await createAssistantFixture(staticRoot);
	try {
		const alpha = await fixture.application.createProject({ name: "Alpha" });
		const beta = await fixture.application.createProject({ name: "Beta" });
		const empty = await fixture.application.createProject({ name: "空项目" });
		const personal = await fixture.application.createSession({ title: "普通讨论" });
		const a = await fixture.application.createSession({ projectId: alpha.id, title: "Alpha 工作" });
		await fixture.application.createSession({ projectId: beta.id, title: "Beta 工作" });
		await page.goto(fixture.address.launchUrl);
		await page.goto(`${fixture.address.origin}/chat?session=${personal.id}`);
		const sidebar = page.getByRole("complementary", { name: "会话列表" });
		const ordinary = sidebar.getByRole("region", { name: "普通会话", exact: true });
		const alphaGroup = sidebar.getByRole("region", { name: "项目 Alpha", exact: true });
		await expect(ordinary.locator(".session-item")).toHaveCount(1);
		await expect(ordinary).not.toContainText("Alpha 工作");
		await expect(alphaGroup.locator(".session-item")).toHaveText(/Alpha 工作/);
		await expect(sidebar.getByRole("region", { name: "项目 空项目", exact: true })).toContainText("暂无会话");
		await sidebar.getByRole("button", { name: "折叠项目 Alpha", exact: true }).click();
		await expect(alphaGroup.locator(".session-item")).toBeHidden();
		await sidebar.getByRole("button", { name: "展开项目 Alpha", exact: true }).click();
		await alphaGroup.getByRole("button", { name: "会话操作 Alpha 工作", exact: true }).click();
		await alphaGroup.getByRole("button", { name: "归档会话", exact: true }).click();
		await expect(alphaGroup.locator(".session-item")).toHaveCount(0);
		await sidebar.getByRole("button", { name: "已归档", exact: true }).click();
		await expect(alphaGroup.locator(".session-item")).toHaveCount(1);
		await expect(ordinary.locator(".session-item")).toHaveCount(0);
		await alphaGroup.getByRole("button", { name: "会话操作 Alpha 工作", exact: true }).click();
		await alphaGroup.getByRole("button", { name: "恢复会话", exact: true }).click();
		await expect(ordinary.locator(".session-item")).toHaveCount(1);
		await fixture.restart();
		await page.goto(fixture.address.launchUrl);
		await page.goto(`${fixture.address.origin}/chat?session=${a.id}`);
		await expect(alphaGroup.locator(".session-item.selected")).toContainText("Alpha 工作");
		await sidebar.getByRole("link", { name: "空项目", exact: true }).click();
		await expect(page).toHaveURL(new RegExp(`/projects/${empty.id}$`));
		await expect(page.locator(".project-title")).toContainText("空项目");
	} finally { await fixture.close(); }
});

test("project and ordinary chat creation from the list use the chosen scope and clear drafts across projects", async ({ page }) => {
	const fixture = await createAssistantFixture(staticRoot);
	try {
		const alpha = await fixture.application.createProject({ name: "Alpha" });
		const beta = await fixture.application.createProject({ name: "Beta" });
		const initial = await fixture.application.createSession({ projectId: alpha.id, title: "Alpha 当前会话" });
		const standard = await fixture.application.services.profiles.getBySlug("standard");
		await page.goto(fixture.address.launchUrl);
		await page.goto(`${fixture.address.origin}/projects/${alpha.id}/chat?session=${initial.id}`);
		await page.getByRole("textbox", { name: "消息输入" }).fill("Alpha 未发送内容");
		const sidebar = page.getByRole("complementary", { name: "会话列表" });
		await sidebar.getByRole("button", { name: "新建项目会话 Beta", exact: true }).click();
		const dialog = page.getByRole("dialog", { name: "新建会话", exact: true });
		await expect(dialog).toContainText("会话归属：Beta");
		await expect(dialog.getByRole("textbox", { name: "会话名称" })).toHaveCount(0);
		await expect(dialog.getByRole("button", { name: "开始对话", exact: true })).toBeDisabled();
		await dialog.getByRole("combobox", { name: "新会话助手" }).selectOption(standard.id);
		await dialog.getByRole("button", { name: "开始对话", exact: true }).click();
		await expect(page).toHaveURL(new RegExp(`/projects/${beta.id}/chat\\?assistant=`));
		await expect(page.getByRole("textbox", { name: "消息输入" })).toHaveValue("");
		expect(await fixture.application.services.sessions.list(beta.id)).toHaveLength(0);
		fixture.faux.setResponses([fauxAssistantMessage("Beta 回答")]);
		await page.getByRole("textbox", { name: "消息输入" }).fill("Beta 新会话");
		await page.getByRole("button", { name: "发送消息", exact: true }).click();
		await expect(page).toHaveURL(new RegExp(`/projects/${beta.id}/chat\\?session=`));
		const betaSessionId = new URL(page.url()).searchParams.get("session")!;
		expect((await fixture.application.services.sessions.get(betaSessionId)).projectId).toBe(beta.id);
		await expect(sidebar.getByRole("region", { name: "项目 Beta", exact: true }).locator(".session-item.selected")).toContainText("Beta 新会话");
		await page.getByRole("textbox", { name: "消息输入" }).fill("Beta 未发送内容");
		await sidebar.getByRole("region", { name: "项目 Alpha", exact: true }).locator(".session-item").click();
		await expect(page).toHaveURL(new RegExp(`/projects/${alpha.id}/chat\\?session=${initial.id}`));
		await expect(page.getByRole("textbox", { name: "消息输入" })).toHaveValue("");
		await sidebar.getByRole("button", { name: "新建会话", exact: true }).click();
		await expect(dialog).toContainText("会话归属：普通会话");
		await dialog.getByRole("combobox", { name: "新会话助手" }).selectOption(standard.id);
		await dialog.getByRole("button", { name: "开始对话", exact: true }).click();
		fixture.faux.setResponses([fauxAssistantMessage("普通回答")]);
		await page.getByRole("textbox", { name: "消息输入" }).fill("新的普通讨论");
		await page.getByRole("button", { name: "发送消息", exact: true }).click();
		await expect(sidebar.getByRole("region", { name: "普通会话", exact: true }).locator(".session-item.selected")).toContainText("新的普通讨论");
		await expect.poll(() => new URL(page.url()).pathname).toBe("/chat");
		const personalId = new URL(page.url()).searchParams.get("session")!;
		expect((await fixture.application.services.sessions.get(personalId)).projectId).toBeUndefined();
		await expect(sidebar.getByRole("region", { name: "普通会话", exact: true }).locator(".session-item.selected")).toContainText("新的普通讨论");
		await page.screenshot({ path: "test-results/session-sidebar-grouped.png" });
	} finally { await fixture.close(); }
});

test("new project in the chat list picks a folder and binds the first chat to it", async ({ page }) => {
	let folder = "";
	let picks = 0;
	const fixture = await createAssistantFixture(staticRoot, { pickDirectory: async () => { picks++; return folder; } });
	try {
		folder = join(fixture.root, "从会话列表创建");
		await mkdir(folder);
		const standard = await fixture.application.services.profiles.getBySlug("standard");
		await page.goto(fixture.address.launchUrl);
		await page.goto(`${fixture.address.origin}/chat`);
		const sidebar = page.getByRole("complementary", { name: "会话列表" });
		await sidebar.getByRole("button", { name: "新建项目", exact: true }).click();
		const dialog = page.getByRole("dialog", { name: "新建会话", exact: true });
		await expect(dialog).toContainText("会话归属：从会话列表创建");
		await expect(sidebar.getByRole("region", { name: "项目 从会话列表创建", exact: true })).toContainText("暂无会话");
		expect(picks).toBe(1);
		await dialog.getByRole("combobox", { name: "新会话助手" }).selectOption(standard.id);
		await dialog.getByRole("button", { name: "开始对话", exact: true }).click();
		expect(await fixture.application.services.sessions.list()).toHaveLength(0);
		fixture.faux.setResponses([fauxAssistantMessage("项目回答")]);
		await page.getByRole("textbox", { name: "消息输入" }).fill("第一条项目会话");
		await page.getByRole("button", { name: "发送消息", exact: true }).click();
		await expect(sidebar.getByRole("region", { name: "项目 从会话列表创建", exact: true }).locator(".session-item.selected")).toContainText("第一条项目会话");
		const sessionId = new URL(page.url()).searchParams.get("session")!;
		const project = (await fixture.application.services.projects.list())[0];
		expect(project.sourcePath).toBe(folder);
		expect((await fixture.application.services.sessions.get(sessionId)).cwd).toBe(folder);
		await expect(sidebar.getByRole("region", { name: "普通会话", exact: true }).locator(".session-item")).toHaveCount(0);
		await page.reload();
		await expect(sidebar.getByRole("region", { name: "项目 从会话列表创建", exact: true }).locator(".session-item.selected")).toContainText("第一条项目会话");
	} finally { await fixture.close(); }
});
