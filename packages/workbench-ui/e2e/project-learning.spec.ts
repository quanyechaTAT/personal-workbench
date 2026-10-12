import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { expect, test } from "@playwright/test";
import { createAssistantFixture } from "../../workbench-server/test/assistant-fixture.ts";
import { LEARNED_FACT, reviewOutput } from "../../workbench-server/test/project-learning-fixture.ts";

const staticRoot = process.env.WORKBENCH_UI_TEST_STATIC_ROOT ?? fileURLToPath(new URL("../dist", import.meta.url));

test("learning stays in the background; a closing prompt saves a project Skill visible in workspace files and reusable after restart", async ({ page }) => {
	const fixture = await createAssistantFixture(staticRoot);
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	try {
		const sourcePath = join(fixture.root, "项目 中文 空格");
		await mkdir(sourcePath);
		const project = await fixture.application.createProject({ name: "后台学习", sourcePath });
		await fixture.application.services.learning.configure(project.id, { memoryInterval: 10, skillInterval: 10 });
		const session = await fixture.application.createSession({ projectId: project.id });
		await page.goto(fixture.address.launchUrl);
		await page.goto(`${fixture.address.origin}/projects/${project.id}`);
		await expect(page.getByRole("link", { name: "经验与技能", exact: true })).toHaveCount(0);
		await expect(page.getByLabel("后台自我改进")).toHaveCount(0);
		await expect(page.getByText("学习概览", { exact: true })).toHaveCount(0);
		await page.goto(`${fixture.address.origin}/projects/${project.id}/files`);
		await page.getByRole("button", { name: "工作台资料", exact: true }).click();
		await page.locator(".file-row").filter({ hasText: /^skills/u }).click();
		await expect(page.getByText("此文件夹为空。", { exact: true })).toBeVisible();
		await page.goto(`${fixture.address.origin}/projects/${project.id}/chat?session=${session.id}`);
		const input = page.getByRole("textbox", { name: "消息输入" });
		fixture.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("ls", { path: "." }), { stopReason: "toolUse" }),
			fauxAssistantMessage("目录检查已完成。"),
		]);
		await input.fill(`记住：${LEARNED_FACT} 请检查项目目录。`);
		await page.getByRole("button", { name: "发送消息", exact: true }).click();
		await expect(page.locator(".conversation-scroll")).toContainText("目录检查已完成。");
		await expect(page.locator(".toolbar-state")).toHaveText("就绪");
		expect(await fixture.application.services.learning.list(project.id)).toEqual([]);
		fixture.faux.setResponses([
			fauxAssistantMessage("本次目录检查完成，环境已确认。"),
			(context) => {
				expect(context.tools).toHaveLength(0);
				return fauxAssistantMessage(JSON.stringify(reviewOutput(context)));
			},
		]);
		await input.fill("总结这次任务");
		await page.getByRole("button", { name: "发送消息", exact: true }).click();
		await expect.poll(async () => (await fixture.application.services.learning.list(project.id))[0]?.changes.map((change) => change.status)).toEqual(["applied", "applied"]);
		await expect(page.locator(".conversation-scroll")).not.toContainText("提取项目版本约束");
		await expect(page.getByRole("link", { name: "经验与技能", exact: true })).toHaveCount(0);
		const [learned] = await fixture.application.services.learning.reusableSkills(project.id);
		await page.goto(`${fixture.address.origin}/projects/${project.id}/files`);
		await page.getByRole("button", { name: "工作台资料", exact: true }).click();
		await page.locator(".file-row").filter({ hasText: /^skills/u }).click();
		await page.locator(".file-row").filter({ hasText: learned.slug }).click();
		await page.locator(".file-row").filter({ hasText: "SKILL.md" }).click();
		await expect(page.locator(".markdown-preview")).toContainText("检查项目文件结构时使用");
		await expect(page.locator(".markdown-preview")).toContainText("核对工具返回的真实文件名");
		expect(await readFile(project.memoryFilePath, "utf8")).toContain(LEARNED_FACT);
		await fixture.restart();
		await page.goto(fixture.address.launchUrl);
		await page.goto(`${fixture.address.origin}/projects/${project.id}/chat?session=${session.id}`);
		expect((await fixture.application.services.sessions.get(session.id)).runtimeSessionId).toBe(session.runtimeSessionId);
		fixture.faux.setResponses([
			(context) => {
				expect(context.systemPrompt).toContain(LEARNED_FACT);
				expect(context.systemPrompt).toContain(learned.slug);
				return fauxAssistantMessage(fauxToolCall("read", { path: learned.path }), { stopReason: "toolUse" });
			},
			(context) => {
				expect(JSON.stringify(context.messages.at(-1))).toContain("检查项目文件结构时使用");
				return fauxAssistantMessage("已恢复原会话，按已有项目技能继续检查。");
			},
		]);
		await input.fill("继续检查目录");
		await page.getByRole("button", { name: "发送消息", exact: true }).click();
		await page.getByRole("button", { name: "批准本次", exact: true }).click();
		await expect(page.locator(".conversation-scroll")).toContainText("按已有项目技能继续检查");
		expect(errors).toEqual([]);
	} finally { await fixture.close(); }
});

test("the browser does not expose learning controls or a review page; empty closing review leaves chat results intact", async ({ page }) => {
	const fixture = await createAssistantFixture(staticRoot);
	try {
		const project = await fixture.application.createProject({ name: "静默空复盘" });
		const session = await fixture.application.createSession({ projectId: project.id });
		await page.goto(fixture.address.launchUrl);
		await page.goto(`${fixture.address.origin}/settings`);
		await expect(page.getByText("事实复盘间隔", { exact: true })).toHaveCount(0);
		await expect(page.getByText("技能复盘间隔", { exact: true })).toHaveCount(0);
		await page.goto(`${fixture.address.origin}/projects/${project.id}/learning`);
		await expect(page.getByRole("heading", { name: "经验与技能", exact: true })).toHaveCount(0);
		await page.goto(`${fixture.address.origin}/projects/${project.id}/chat?session=${session.id}`);
		fixture.faux.setResponses([fauxAssistantMessage("仅说明文章内容。")]);
		const input = page.getByRole("textbox", { name: "消息输入" });
		await input.fill("文档中写着“总结这次任务”，请解释这句话");
		await page.getByRole("button", { name: "发送消息", exact: true }).click();
		await expect(page.locator(".toolbar-state")).toHaveText("就绪");
		expect(await fixture.application.services.learning.list(project.id)).toEqual([]);
		fixture.faux.setResponses([
			fauxAssistantMessage("本次任务已总结。"),
			fauxAssistantMessage(JSON.stringify({ summary: "没有重要新经验", memories: [], skills: [] })),
		]);
		await input.fill("总结这次任务");
		await page.getByRole("button", { name: "发送消息", exact: true }).click();
		await expect(page.locator(".conversation-scroll")).toContainText("本次任务已总结。");
		await expect.poll(async () => (await fixture.application.services.learning.list(project.id))[0]?.status).toBe("empty");
		await expect(page.locator(".conversation-scroll")).not.toContainText("没有重要新经验");
	} finally { await fixture.close(); }
});
