import { readdir, readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { expect, test } from "@playwright/test";
import { createAssistantFixture } from "../../workbench-server/test/assistant-fixture.ts";

test("browser edits root USER.md and two project sessions reuse it after migration and restart", async ({ page }) => {
	const fixture = await createAssistantFixture(fileURLToPath(new URL("../dist", import.meta.url)));
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	try {
		const paths = fixture.application.paths;
		const old = await fixture.application.services.memory.propose({}, { kind: "user", proposedText: "用户偏好使用简短中文。", reason: "迁移前用户确认" });
		await fixture.application.services.memory.accept(old.id);
		await rename(paths.userMemory, join(paths.workspace, "USER.md"));
		await fixture.restart();
		expect(await readdir(paths.workspace)).not.toContain("USER.md");
		const projects = await Promise.all(["甲项目 中文 空格", "乙项目 中文 空格"].map((name) => fixture.application.createProject({ name })));
		await page.goto(fixture.address.launchUrl);
		await page.goto(`${fixture.address.origin}/memory`);
		await page.locator(".memory-library aside").getByRole("button", { name: /工作台根目录 \/ USER.md/u }).click();
		const editor = page.locator(".memory-library section textarea");
		await expect(editor).toHaveValue(/用户偏好使用简短中文。/u);
		const preference = "以后所有项目的回答都先给一句结论，再用编号列表列出步骤。";
		const content = `${await editor.inputValue()}\n## 全局交互偏好\n${preference}\n`;
		await editor.fill(content);
		await page.locator(".memory-library section").getByRole("button", { name: "保存", exact: true }).click();
		await expect(page.locator(".memory-library section").getByRole("button", { name: "保存", exact: true })).toBeDisabled();
		await expect.poll(() => readFile(paths.userMemory, "utf8")).toBe(content);
		expect(await readdir(paths.workspace)).not.toContain("USER.md");
		const sessions = await Promise.all(projects.map((project) => fixture.application.createSession({ projectId: project.id, profileSlug: "standard" })));
		for (const restarted of [false, true]) {
			if (restarted) {
				await fixture.restart();
				await page.goto(fixture.address.launchUrl);
			}
			for (const [index, session] of sessions.entries()) {
				const answer = `可以继续。\n\n1. 确认目标。\n2. 检查结果。${restarted ? "重启之后。" : ""}`;
				fixture.faux.setResponses([(context) => {
					expect(JSON.stringify(context)).toContain(preference);
					return fauxAssistantMessage(answer);
				}]);
				await page.goto(`${fixture.address.origin}/projects/${projects[index].id}/chat?session=${session.id}`);
				await page.getByRole("textbox", { name: "消息输入" }).fill("给出两个继续任务的步骤，不调用工具。");
				await page.getByRole("button", { name: "发送消息", exact: true }).click();
				await expect(page.locator(".conversation-scroll")).toContainText("确认目标");
				await expect(page.locator(".toolbar-state")).toHaveText("就绪");
				const manifest = page.getByRole("region", { name: "本轮实际记忆上下文" });
				if (!(await manifest.isVisible())) await page.getByRole("button", { name: "会话详情", exact: true }).click();
				await expect(manifest).toContainText(preference);
				expect((await fixture.application.services.sessions.get(session.id)).runtimeSessionId).toBe(session.runtimeSessionId);
			}
		}
		await page.goto(`${fixture.address.origin}/memory`);
		await page.locator(".memory-library aside").getByRole("button", { name: /工作台根目录 \/ USER.md/u }).click();
		await expect(editor).toHaveValue(content);
		for (const project of projects) expect(await readdir(project.workspacePath)).not.toContain("USER.md");
		expect(await readdir(paths.workspace)).not.toContain("USER.md");
		expect(errors).toEqual([]);
	} finally { await fixture.close(); }
});
