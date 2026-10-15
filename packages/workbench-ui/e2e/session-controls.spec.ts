import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { createAssistantFixture } from "../../workbench-server/test/assistant-fixture.ts";

const staticRoot = process.env.WORKBENCH_UI_TEST_STATIC_ROOT ?? fileURLToPath(new URL("../dist", import.meta.url));

test("assistant changes keep the conversation, and archive, restore and deletion survive restart", async ({page})=>{
	const fixture=await createAssistantFixture(staticRoot);
	try {
		const standard=await fixture.application.services.profiles.getBySlug("standard");
		const ptc=await fixture.application.services.profiles.getBySlug("ptc");
		const session=await fixture.application.createSession({profileId:standard.id,title:"切换助手保留历史"});
		await page.goto(fixture.address.launchUrl); await page.goto(`${fixture.address.origin}/chat?session=${session.id}`);
		fixture.faux.setResponses([fauxAssistantMessage("原助手留下的历史")]);
		await page.getByRole("textbox",{name:"消息输入"}).fill("第一轮"); await page.getByRole("button",{name:"发送消息"}).click();
		await expect(page.locator(".conversation-scroll")).toContainText("原助手留下的历史"); await expect(page.locator(".toolbar-state")).toHaveText("就绪");
		await page.getByRole("combobox",{name:"助手",exact:true}).selectOption(ptc.id);
		await expect.poll(async()=>(await fixture.application.services.sessions.get(session.id)).agentProfileId).toBe(ptc.id);
		expect(new URL(page.url()).searchParams.get("session")).toBe(session.id);
		await page.reload(); await expect(page.getByRole("combobox",{name:"助手",exact:true})).toHaveValue(ptc.id);
		await expect(page.locator(".conversation-scroll")).toContainText("原助手留下的历史");
		await page.goto(`${fixture.address.origin}/assistants`);
		const standardCard=page.locator(".assistant-card").filter({has:page.getByRole("heading",{name:"标准助手",exact:true})});
		await standardCard.getByRole("button",{name:"归档",exact:true}).click(); await expect(standardCard).toHaveCount(0);
		await page.getByLabel("显示已归档助手").check(); await standardCard.getByRole("button",{name:"恢复",exact:true}).click();
		await expect(standardCard.getByRole("button",{name:"归档",exact:true})).toBeVisible();
		const ptcCard=page.locator(".assistant-card").filter({has:page.getByRole("heading",{name:"PTC助手",exact:true})});
		page.once("dialog",dialog=>dialog.dismiss()); await ptcCard.getByRole("button",{name:"删除",exact:true}).click(); await expect(ptcCard).toHaveCount(1);
		page.once("dialog",dialog=>dialog.accept()); await ptcCard.getByRole("button",{name:"删除",exact:true}).click(); await expect(ptcCard).toHaveCount(0);
		await page.goto(`${fixture.address.origin}/chat?session=${session.id}`);
		await expect(page.locator(".conversation-scroll")).toContainText("原助手留下的历史");
		await page.getByRole("textbox",{name:"消息输入"}).fill("改选后继续"); await expect(page.getByRole("button",{name:"发送消息"})).toBeDisabled();
		await page.getByRole("combobox",{name:"助手",exact:true}).selectOption(standard.id);
		await expect(page.getByRole("button",{name:"发送消息"})).toBeEnabled();
		fixture.faux.setResponses([fauxAssistantMessage("仍在原会话继续")]); await page.getByRole("button",{name:"发送消息"}).click();
		await expect(page.locator(".conversation-scroll")).toContainText("仍在原会话继续"); await expect(page.locator(".toolbar-state")).toHaveText("就绪");
		await fixture.restart(); expect(await fixture.application.services.sessions.list()).toHaveLength(1);
		expect((await fixture.application.services.profiles.list(true)).some(profile=>profile.id===ptc.id)).toBe(false);
		await page.goto(fixture.address.launchUrl); await page.goto(`${fixture.address.origin}/chat?session=${session.id}`);
		await expect(page.getByRole("combobox",{name:"助手",exact:true})).toHaveValue(standard.id);
		await expect(page.locator(".message-user")).toHaveCount(2);
	}finally{await fixture.close();}
});

test("named sessions can be renamed, survive restart and work in a small project window", async ({ page }) => {
	const fixture = await createAssistantFixture(staticRoot);
	try {
		const previous = await fixture.application.createSession({ title: "已有会话" });
		await page.goto(fixture.address.launchUrl);
		await page.goto(`${fixture.address.origin}/chat?session=${previous.id}`);
		await page.getByRole("button", { name: "新建会话", exact: true }).filter({ visible: true }).click();
		await expect(page.getByRole("textbox", { name: "会话名称", exact: true })).toHaveCount(0);
		await expect(page.getByRole("button", { name: "开始对话", exact: true })).toBeDisabled();
		await page.getByRole("combobox", { name: "新会话助手" }).selectOption((await fixture.application.services.profiles.getBySlug("standard")).id);
		await page.getByRole("button", { name: "开始对话", exact: true }).click();
		expect(await fixture.application.services.sessions.list()).toHaveLength(1);
		fixture.faux.setResponses([fauxAssistantMessage("学习计划已记录")]);
		await page.getByRole("textbox", { name: "消息输入" }).fill("CV 学习计划");
		await page.getByRole("button", { name: "发送消息", exact: true }).click();
		await expect.poll(async () => (await fixture.application.services.sessions.list()).length).toBe(2);
		await expect(page.locator(".conversation-scroll")).toContainText("学习计划已记录");
		await expect(page).toHaveURL(/session=/);
		await expect.poll(() => new URL(page.url()).searchParams.get("session")).not.toBe(previous.id);
		await page.reload();
		await expect(page.locator(".session-item")).toHaveCount(2);
		await expect(page.locator(".session-item.selected")).toContainText("CV 学习计划");
		await page.getByRole("button", { name: "会话操作 CV 学习计划" }).click();
		await page.getByRole("button", { name: "重命名会话", exact: true }).filter({ visible: true }).click();
		await page.getByRole("textbox", { name: "会话名称", exact: true }).fill("CV 学习：第一周");
		await page.getByRole("button", { name: "保存名称", exact: true }).click();
		await expect(page.locator(".session-item.selected")).toContainText("CV 学习：第一周");
		const createdId = new URL(page.url()).searchParams.get("session");
		await fixture.restart();
		await page.goto(fixture.address.launchUrl);
		await page.goto(`${fixture.address.origin}/chat?session=${createdId}`);
		await expect(page.locator(".session-item.selected")).toContainText("CV 学习：第一周");
		const project = await fixture.application.createProject({ name: "新建会话项目" });
		await fixture.application.createSession({ projectId: project.id, title: "项目旧会话" });
		await page.setViewportSize({ width: 760, height: 620 });
		await page.goto(`${fixture.address.origin}/projects/${project.id}/chat`);
		await page.getByRole("button", { name: "新建会话", exact: true }).filter({ visible: true }).click();
		await page.getByRole("combobox", { name: "新会话助手" }).selectOption((await fixture.application.services.profiles.getBySlug("standard")).id);
		await page.getByRole("button", { name: "开始对话", exact: true }).click();
		fixture.faux.setResponses([fauxAssistantMessage("研究记录已创建")]);
		await page.getByRole("textbox", { name: "消息输入" }).fill("项目第二次研究");
		await page.getByRole("button", { name: "发送消息", exact: true }).click();
		await expect.poll(async () => (await fixture.application.services.sessions.list(project.id)).length).toBe(2);
		await expect(page.locator(".conversation-scroll")).toContainText("研究记录已创建");
		await page.locator(".compact-session-actions summary").click();
		await page.getByRole("button", { name: "重命名会话", exact: true }).filter({ visible: true }).click();
		await page.getByRole("textbox", { name: "会话名称", exact: true }).fill("窄窗口重命名");
		await page.getByRole("button", { name: "保存名称", exact: true }).click();
		await expect(page.getByRole("combobox", { name: "切换会话" })).toContainText("窄窗口重命名");
	} finally {
		await fixture.close();
	}
});

test("slash lists imported Skills immediately, keeps tools automatic and filters unconfigured models", async ({ page }) => {
	let sourceFile = "";
	const fixture = await createAssistantFixture(staticRoot, { pickSkillFile: async () => sourceFile });
	try {
		const session = await fixture.application.createSession({ profileSlug: "standard" });
		await page.goto(fixture.address.launchUrl);
		await page.goto(`${fixture.address.origin}/chat?session=${session.id}`);
		const modelOptions = page.getByRole("combobox", { name: "模型", exact: true }).locator("option");
		await expect(modelOptions).toHaveCount(2);
		await expect(modelOptions).not.toContainText(["未配置"]);
		const source = join(fixture.root, "slash-source", "ask-matt");
		sourceFile = join(source, "SKILL.md");
		await mkdir(source, { recursive: true });
		await writeFile(join(source, "SKILL.md"), "---\nname: ask-matt\ndescription: 研究与证据检查\n---\nASK_MATT_CHECKLIST: verify evidence before answering.");
		await page.locator('a[href="/skills"]').first().click();
		await page.getByRole("button", { name: "导入技能", exact: true }).click();
		await expect(page.getByLabel("技能文件", { exact: true })).toHaveAttribute("readonly");
		await page.getByRole("button", { name: "选择文件…", exact: true }).click();
		await expect(page.getByLabel("技能文件", { exact: true })).toHaveValue(sourceFile);
		await page.getByRole("button", { name: "预览导入", exact: true }).click();
		await page.getByRole("button", { name: "导入 1 个技能", exact: true }).click();
		await expect(page.locator(".skill-card").filter({ hasText: "ask-matt" })).toBeVisible();
		await page.locator('a[href="/chat"]').first().click();
		await page.locator(".session-item").filter({ hasText: session.title }).click();
		await page.getByRole("textbox", { name: "消息输入" }).fill("/");
		const skillMenu = page.getByRole("listbox", { name: "命令与技能", exact: true });
		await expect(skillMenu).toBeVisible();
		await expect(skillMenu.getByRole("option").filter({ hasText: "ask-matt" })).toBeVisible();
		await expect(skillMenu).not.toContainText("task_list");
		const input = page.getByRole("textbox", { name: "消息输入" });
		await input.press("ArrowDown");
		await expect(skillMenu.getByRole("option").nth(1)).toHaveAttribute("aria-selected", "true");
		await input.press("Escape");
		await expect(skillMenu).toHaveCount(0);
		await input.fill("/ask-matt");
		await input.press("Enter");
		await expect(page.getByRole("button", { name: "移除 ask-matt" })).toBeVisible();
		await expect(input).toHaveValue("");
		await expect(page.locator(".message-user")).toHaveCount(0);
		fixture.faux.setResponses([
			(context) => {
				expect(context.systemPrompt).not.toContain("用户为本轮明确选择了这些工具");
				expect(JSON.stringify(context.messages.at(-1))).toContain("<skill name=");
				expect(JSON.stringify(context.messages.at(-1))).toContain("ASK_MATT_CHECKLIST");
				return fauxAssistantMessage(fauxToolCall("task_list", {}, { id: "slash-tasks" }), { stopReason: "toolUse" });
			},
			fauxAssistantMessage("已按照研究流程查看任务"),
		]);
		await input.fill("查看任务");
		await page.getByRole("button", { name: "发送消息" }).click();
		await expect(page.locator(".conversation-scroll")).toContainText("已按照研究流程查看任务");
		await expect(page.locator(".toolbar-state")).toHaveText("就绪");
		await expect(page.locator(".tool-card")).toContainText("任务列表");
		await expect(page.locator(".skill-invocation summary")).toHaveText("已使用技能：ask-matt");
		await expect(page.locator(".skill-invocation")).not.toHaveAttribute("open");
		await expect(page.locator(".selected-capabilities")).toHaveCount(0);
		await page.setViewportSize({ width: 760, height: 620 });
		await input.fill("/ask");
		const menuBox = await page.locator(".slash-popup").boundingBox();
		expect(menuBox!.y).toBeGreaterThan(0);
		expect(menuBox!.y + menuBox!.height).toBeLessThan(620);
		await page.screenshot({ path: "test-results/chat-slash-menu.png" });
		await input.press("Tab");
		await expect(page.getByRole("button", { name: "移除 ask-matt" })).toBeVisible();
		await fixture.restart();
		await page.goto(fixture.address.launchUrl);
		await page.goto(`${fixture.address.origin}/chat?session=${session.id}`);
		await input.fill("/ask");
		await expect(skillMenu.getByRole("option").filter({ hasText: "ask-matt" })).toBeVisible();
	} finally {
		await fixture.close();
	}
});

test("session archive, restore and confirmed delete work in the browser and survive restart", async ({ page }) => {
	const fixture = await createAssistantFixture(staticRoot);
	try {
		const session = await fixture.application.createSession({ title: "会话管理测试" });
		await page.goto(fixture.address.launchUrl);
		await page.goto(`${fixture.address.origin}/chat?session=${session.id}`);
		await page.getByRole("button", { name: "会话操作 会话管理测试" }).click();
		await page.getByRole("button", { name: "归档会话", exact: true }).filter({ visible: true }).click();
		await expect(page.locator(".session-item")).toHaveCount(0);
		await page.getByRole("button", { name: "已归档", exact: true }).click();
		await expect(page.locator(".session-item")).toHaveCount(1);
		await page.locator(".session-item").click();
		await expect(page.getByRole("textbox", { name: "消息输入" })).toBeDisabled();
		await page.reload();
		await expect(page.getByRole("textbox", { name: "消息输入" })).toBeDisabled();
		await page.getByRole("button", { name: "恢复会话", exact: true }).filter({ visible: true }).click();
		await expect(page.getByRole("textbox", { name: "消息输入" })).toBeEnabled();
		await expect(page.locator(".session-item")).toHaveCount(1);
		await page.getByRole("button", { name: "会话操作 会话管理测试" }).click();
		await page.getByRole("button", { name: "删除会话", exact: true }).filter({ visible: true }).click();
		const deletion = page.getByRole("dialog", { name: "删除会话", exact: true });
		await expect(deletion.getByRole("combobox", { name: "会话工作区" })).toHaveValue("migrate");
		await deletion.getByRole("button", { name: "取消", exact: true }).click();
		await expect(page.locator(".session-item")).toHaveCount(1);
		await page.getByRole("button", { name: "删除会话", exact: true }).filter({ visible: true }).click();
		await deletion.getByRole("button", { name: "确认删除", exact: true }).click();
		await expect(page.locator(".session-item")).toHaveCount(0);
		await fixture.restart();
		await page.goto(fixture.address.launchUrl);
		await page.goto(`${fixture.address.origin}/chat`);
		await expect(page.locator(".session-item")).toHaveCount(0);
	} finally { await fixture.close(); }
});
