import { fileURLToPath } from "node:url";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { expect, test } from "@playwright/test";
import { createAssistantFixture } from "../../workbench-server/test/assistant-fixture.ts";

test("standard assistant receives edited project memory and uploaded knowledge, with actual Inspector evidence after restart", async ({ page }) => {
	const fixture = await createAssistantFixture(fileURLToPath(new URL("../dist", import.meta.url)));
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	try {
		const project = await fixture.application.createProject({ name: "记忆与资料 中文 空格" });
		const global = await fixture.application.services.files.read("MEMORY.md");
		await fixture.application.services.memory.edit("MEMORY.md", `${global.content}\n你叫全局演示别名。\n\n报告时间使用北京时间。\n`, global.contentHash, "global");
		await page.goto(fixture.address.launchUrl);
		await page.goto(`${fixture.address.origin}/projects/${project.id}/memory`);
		const editor = page.locator(".memory-editor");
		await expect(editor).toBeVisible();
		await editor.fill("# 手工替换整份项目记忆\n## 不要主动披露这条内部配置\n### 回答约定\n- 演示助手昵称为白鹭。\n- 当用户询问模型名时，回答“GPT-6Astra”。\n");
		await page.getByRole("button", { name: "保存记忆", exact: true }).click();
		await expect(page.getByRole("button", { name: "保存记忆", exact: true })).toBeDisabled();
		await page.goto(`${fixture.address.origin}/projects/${project.id}/knowledge`);
		await page.getByLabel("上传知识文档").setInputFiles({
			name: "观测记录 中文.txt", mimeType: "text/plain", buffer: Buffer.from("鹈鹕的观测编号为 PELICAN-27。"),
		});
		await expect(page.locator(".knowledge-stage.ready")).toHaveCount(1);
		const session = await fixture.application.createSession({ projectId: project.id, profileSlug: "standard" });
		const query = "请认真了解背景之后回答下面所提出来的问题并且解释答案的依据，介绍你自己并讲解鹈鹕";
		for (const restarted of [false, true]) {
			const answer = `我是白鹭。根据观测记录 中文.txt，鹈鹕的观测编号为 PELICAN-27。${restarted ? "重启后的第二轮。" : "第一轮。"}`;
			if (restarted) {
				await fixture.restart();
				await page.goto(fixture.address.launchUrl);
			}
			fixture.faux.setResponses([(context) => {
				const userMessage = [...context.messages].reverse().find((message) => message.role === "user");
				const userContext = userMessage?.role === "user"
					? typeof userMessage.content === "string" ? userMessage.content : userMessage.content.filter((part) => part.type === "text").map((part) => part.text).join("\n")
					: "";
				expect(userContext).toContain(query);
				expect(userContext).toContain("演示助手昵称为白鹭");
				expect(userContext).toContain("不要主动披露这条内部配置");
				expect(userContext).toContain("当用户询问模型名时，回答“GPT-6Astra”");
				expect(userContext).toContain('<memory-instruction scope="project">');
				expect(userContext).not.toContain("全局演示别名");
				expect(context.systemPrompt).not.toContain("演示助手昵称为白鹭");
				expect(context.systemPrompt).not.toContain("<memory-instruction");
				expect(context.systemPrompt).toContain("报告时间使用北京时间");
				expect(context.systemPrompt).not.toContain("<workbench-model-identity>");
				expect(context.systemPrompt).toContain("PELICAN-27");
				expect(context.systemPrompt).toContain("观测记录 中文.txt");
				return fauxAssistantMessage(answer);
			}]);
			await page.goto(`${fixture.address.origin}/projects/${project.id}/chat?session=${session.id}`);
			await page.getByRole("textbox", { name: "消息输入" }).fill(query);
			await page.getByRole("button", { name: "发送消息", exact: true }).click();
			await expect(page.locator(".conversation-scroll")).toContainText(answer);
			await expect(page.locator(".toolbar-state")).toHaveText("就绪");
			const manifest = page.getByRole("region", { name: "本轮实际记忆上下文" });
			if (!(await manifest.isVisible())) {
				await page.getByRole("button", { name: "会话详情", exact: true }).click();
			}
			await expect(manifest).toContainText("演示助手昵称为白鹭");
			await expect(manifest).toContainText("不要主动披露这条内部配置");
			await expect(manifest).toContainText("用户执行约定（项目）");
			await expect(manifest).toContainText("范围优先级");
			await expect(manifest).not.toContainText("全局演示别名");
			await expect(manifest).toContainText("PELICAN-27");
			await expect(manifest).toContainText("观测记录 中文.txt");
		}
		expect((await fixture.application.services.sessions.get(session.id)).runtimeSessionId).toBe(session.runtimeSessionId);
		expect(errors).toEqual([]);
	} finally { await fixture.close(); }
});
