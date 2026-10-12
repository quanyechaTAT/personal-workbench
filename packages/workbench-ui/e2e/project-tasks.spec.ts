import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { createAssistantFixture } from "../../workbench-server/test/assistant-fixture.ts";

const staticRoot = process.env.WORKBENCH_UI_TEST_STATIC_ROOT ?? fileURLToPath(new URL("../dist", import.meta.url));

test("link local project, choose assistants, delegate a task, restart and clean completed history", async ({ page }) => {
	let sourcePath = "";
	const fixture = await createAssistantFixture(staticRoot, { pickDirectory: async () => sourcePath });
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	try {
		sourcePath = join(fixture.root, "本机已有项目");
		await mkdir(sourcePath);
		await writeFile(join(sourcePath, "README.md"), "# Original project\nDo not copy the repository.");
		const preset = await fixture.application.services.profiles.getBySlug("ptc");
		const worker = await fixture.application.services.profiles.create({ name: "任务专用研究助手", systemPrompt: "EXPLICIT_TASK_ASSISTANT", tools: ["write", "task_list", "verify_changes", "accept_changes"] });
		await page.goto(fixture.address.launchUrl);
		await page.getByRole("link", { name: "项目", exact: true }).first().click();
		await page.getByRole("button", { name: "打开文件夹为项目", exact: true }).click();
		await expect(page.getByLabel("已有项目目录", { exact: true })).toHaveValue(sourcePath);
		await page.getByRole("button", { name: "创建项目", exact: true }).click();
		await expect(page.locator(".project-title")).toContainText("本机已有项目");
		await expect(page.locator(".project-hero")).toContainText(sourcePath);
		const project = (await fixture.application.services.projects.list())[0];
		expect(project.defaultProfileId).toBeUndefined();
		await page.getByLabel("启动助手预设", { exact: true }).selectOption(preset.id);
		await page.getByRole("button", { name: "启动助手", exact: true }).click();
		await expect(page.getByRole("textbox", { name: "消息输入" })).toBeEnabled();
		const initialSessionId = new URL(page.url()).searchParams.get("session")!;
		expect((await fixture.application.services.sessions.get(initialSessionId)).cwd).toBe(project.sourcePath);
		fixture.faux.setResponses([fauxAssistantMessage("第一项目会话独有内容"), fauxAssistantMessage("第二项目会话独有内容")]);
		await page.getByRole("textbox", { name: "消息输入" }).fill("第一会话的问题");
		await page.getByRole("button", { name: "发送消息" }).click();
		await expect(page.locator(".conversation-scroll")).toContainText("第一项目会话独有内容");
		await expect(page.locator(".toolbar-state")).toHaveText("就绪");
		await page.getByRole("button", { name: "新建项目会话 本机已有项目", exact: true }).click();
		await page.getByRole("combobox", { name: "新会话助手" }).selectOption(preset.id);
		await page.getByRole("button", { name: "开始对话" }).click();
		await expect(page.locator(".conversation-scroll")).not.toContainText("第一项目会话独有内容");
		await page.getByRole("textbox", { name: "消息输入" }).fill("第二会话的问题");
		await page.getByRole("button", { name: "发送消息" }).click();
		await expect(page.locator(".conversation-scroll")).toContainText("第二项目会话独有内容");
		await expect(page.locator(".toolbar-state")).toHaveText("就绪");
		const secondSessionId = new URL(page.url()).searchParams.get("session")!;
		expect((await fixture.application.services.sessions.get(secondSessionId)).projectId).toBe(project.id);
		await expect(page.locator(".session-item.selected")).toContainText("第二会话的问题");
		await page.locator(".session-item").nth(1).click();
		await expect(page.locator(".conversation-scroll")).toContainText("第一项目会话独有内容");
		await expect(page.locator(".conversation-scroll")).not.toContainText("第二项目会话独有内容");
		await page.locator(".session-item").nth(0).click();
		expect((await fixture.application.services.sessions.readTranscript(initialSessionId)).filter((message) => message.role === "user")).toHaveLength(1);
		expect((await fixture.application.services.sessions.readTranscript(secondSessionId)).filter((message) => message.role === "user")).toHaveLength(1);
		await page.locator(".project-tabs").getByRole("link", { name: "文件", exact: true }).click();
		await page.getByRole("button", { name: /README.md/ }).click();
		await expect(page.locator(".markdown-preview")).toContainText("Original project");
		await page.getByRole("button", { name: "工作台资料", exact: true }).click();
		await expect(page.getByRole("button", { name: /AGENTS.md/ })).toBeVisible();
		await expect(page.getByRole("button", { name: /(?:PROJECT|MEMORY)\.md/ })).toHaveCount(0);
		await page.locator(".project-tabs").getByRole("link", { name: "任务", exact: true }).click();
		await page.getByPlaceholder("添加任务…").fill("制作本机项目清单");
		await page.getByRole("button", { name: "添加任务", exact: true }).click();
		const row = page.locator(".task-row").filter({ hasText: "制作本机项目清单" });
		await row.getByRole("button", { name: "交给助手", exact: true }).click();
		const dialog = page.getByRole("dialog", { name: "交给助手执行", exact: true });
		await expect(dialog.getByLabel("执行助手", { exact: true })).toHaveValue("");
		await dialog.getByLabel("执行助手", { exact: true }).selectOption(worker.id);
		fixture.faux.setResponses([
			(context) => { expect(context.systemPrompt).toContain("EXPLICIT_TASK_ASSISTANT"); return fauxAssistantMessage(fauxToolCall("write", { path: "task-result.txt", content: "local task output" }), { stopReason: "toolUse" }); },
			fauxAssistantMessage(fauxToolCall("verify_changes", { command: "if ((Get-Content -LiteralPath task-result.txt -Raw) -ne 'local task output') { throw 'Unexpected task output' }" }, { id: "task-check" }), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("accept_changes", { criteria: [{ requirement: "创建项目清单文件", checkIds: ["task-check"], evidence: "实际读取文件，确认内容为 local task output" }] }), { stopReason: "toolUse" }),
			fauxAssistantMessage("本机项目任务已完成，请确认。"),
		]);
		await dialog.getByRole("button", { name: "开始执行", exact: true }).click();
		await page.getByRole("button", { name: "批准本次", exact: true }).click();
		await expect(page.locator(".conversation-scroll")).toContainText("本机项目任务已完成，请确认。");
		await expect(page.locator(".toolbar-state")).toHaveText("就绪");
		const taskSessionId = new URL(page.url()).searchParams.get("session")!;
		const session = await fixture.application.services.sessions.get(taskSessionId);
		expect(session.agentProfileId).toBe(worker.id);
		expect(await readFile(join(sourcePath, "task-result.txt"), "utf8")).toBe("local task output");
		await fixture.restart();
		await page.goto(fixture.address.launchUrl);
		await page.goto(`${fixture.address.origin}/projects/${project.id}/tasks`);
		await expect(row).toContainText("待确认");
		await row.getByRole("link", { name: "查看执行", exact: true }).click();
		await expect(page.locator(".conversation-scroll")).toContainText("本机项目任务已完成，请确认。");
		await page.goto(`${fixture.address.origin}/projects/${project.id}/tasks`);
		await row.getByRole("button", { name: "确认完成 制作本机项目清单", exact: true }).click();
		await expect(row).toContainText("已完成");
		await page.getByRole("button", { name: "清理已完成任务", exact: true }).click();
		const cleanup = page.getByRole("dialog", { name: "清理已完成任务", exact: true });
		await cleanup.getByLabel("完成时间范围", { exact: true }).selectOption("0");
		await cleanup.getByRole("button", { name: "预览清理范围", exact: true }).click();
		await expect(cleanup.locator(".cleanup-preview")).toContainText("制作本机项目清单");
		await expect(cleanup).toContainText("1 个任务专用会话");
		await cleanup.getByRole("button", { name: "确认清理", exact: true }).click();
		await expect(cleanup.locator("output")).toContainText("已清理 1 个任务、1 个会话");
		await cleanup.getByRole("button", { name: "关闭", exact: true }).click();
		await expect(row).toHaveCount(0);
		await expect(stat(session.runtimeRef)).rejects.toMatchObject({ code: "ENOENT" });
		expect(await readFile(join(sourcePath, "task-result.txt"), "utf8")).toBe("local task output");
		await fixture.restart();
		expect(await fixture.application.services.projects.list()).toHaveLength(1);
		expect(await fixture.application.services.tasks.list()).toHaveLength(0);
		expect((await fixture.application.services.sessions.list()).map((item) => item.id).sort()).toEqual([initialSessionId, secondSessionId].sort());
		expect(errors).toEqual([]);
	} finally { await fixture.close(); }
});

test("personal tasks also offer assistant selection from the task board", async ({ page }) => {
	const fixture = await createAssistantFixture(staticRoot);
	try {
		const task = await fixture.application.services.tasks.create({ title: "个人日程整理" });
		const profile = await fixture.application.services.profiles.getBySlug("standard");
		await page.goto(fixture.address.launchUrl);
		await page.goto(`${fixture.address.origin}/tasks`);
		await page.locator(".task-card").filter({ hasText: task.title }).getByRole("button", { name: "交给助手" }).click();
		await expect(page.getByRole("button", { name: "开始执行", exact: true })).toBeDisabled();
		await page.getByLabel("执行助手", { exact: true }).selectOption(profile.id);
		fixture.faux.setResponses([fauxAssistantMessage("个人任务执行完成")]);
		await page.getByRole("button", { name: "开始执行", exact: true }).click();
		await expect(page.locator(".conversation-scroll")).toContainText("个人任务执行完成");
		await expect(page.locator(".toolbar-state")).toHaveText("就绪");
		const sessionId = new URL(page.url()).searchParams.get("session")!;
		expect((await fixture.application.services.sessions.get(sessionId)).agentProfileId).toBe(profile.id);
		expect((await fixture.application.services.tasks.get(task.id)).status).toBe("review");
	} finally { await fixture.close(); }
});
