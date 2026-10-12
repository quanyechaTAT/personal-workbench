import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { createAssistantFixture } from "../../workbench-server/test/assistant-fixture.ts";

const staticRoot = process.env.WORKBENCH_UI_TEST_STATIC_ROOT ?? fileURLToPath(new URL("../dist", import.meta.url));

test("Ctrl-click previews a chat file in the side panel and keeps the preview with its session", async ({ page }) => {
	const fixture = await createAssistantFixture(staticRoot);
	try {
		const sourcePath = join(fixture.root, "文件预览项目");
		await mkdir(sourcePath);
		await writeFile(join(sourcePath, "notes.md"), "# 项目备忘\n\n这份文件属于当前会话。", "utf8");
		const project = await fixture.application.services.projects.create({ name: "Preview Project", sourcePath });
		const session = await fixture.application.createSession({ projectId: project.id, title: "预览测试" });
		fixture.faux.setResponses([fauxAssistantMessage("请看 [项目备忘](notes.md) 或 `notes.md`。")]);
		const submitted = await fixture.request(`/sessions/${session.id}/messages`, {
			method: "POST",
			body: JSON.stringify({ text: "打开备忘" }),
		});
		expect(submitted.status).toBe(202);
		const { runId } = (await submitted.json()) as { runId: string };
		for await (const entry of fixture.application.events.subscribe(runId))
			expect(entry.event.type).not.toBe("run.failed");
		await page.goto(fixture.address.launchUrl);
		await page.goto(`${fixture.address.origin}/chat?session=${session.id}`);
		const link = page.locator(".conversation-scroll a", { hasText: "项目备忘" });
		await expect(link).toBeVisible();
		await link.click({ modifiers: ["Control"] });
		await expect(page.getByLabel("文件预览", { exact: true })).toContainText("这份文件属于当前会话");
		const other = await fixture.application.createSession({ projectId: project.id, title: "独立会话" });
		await page.goto(`${fixture.address.origin}/chat?session=${other.id}`);
		await expect(page.getByLabel("文件预览", { exact: true })).toHaveCount(0);
	} finally {
		await fixture.close();
	}
});
