import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { createAssistantFixture } from "../../workbench-server/test/assistant-fixture.ts";

test("Workspace keeps global MEMORY, root USER and one project AGENTS document editable from Files and Memory", async ({ page }) => {
	const fixture = await createAssistantFixture(fileURLToPath(new URL("../dist", import.meta.url)));
	const errors: string[] = []; page.on("pageerror", (error) => errors.push(error.message));
	try {
		const project = await fixture.application.createProject({ name: "单一项目资料", description: "项目概况可在一个文件维护" });
		const candidate = await fixture.application.services.memory.propose({ project }, { kind: "project", proposedText: "项目使用 Python 3.12。", reason: "用户确认" });
		await fixture.application.services.memory.accept(candidate.id);
		await page.goto(fixture.address.launchUrl); await page.goto(`${fixture.address.origin}/files`);
		await expect(page.locator(".file-list").getByRole("button", { name: /MEMORY\.md/ })).toBeVisible();
		await expect(page.locator(".file-list").getByRole("button", { name: /USER\.md/ })).toHaveCount(0);
		await expect(page.locator(".file-list").getByRole("button", { name: /(?:AGENTS|IDENTITY)\.md/ })).toHaveCount(0);
		await page.screenshot({ path: "test-results/workspace-canonical-global.png" });
		await page.goto(`${fixture.address.origin}/memory`);
		await page.locator(".memory-library aside").getByRole("button", { name: /工作台根目录 \/ USER.md/u }).click();
		await expect(page.locator(".memory-library section textarea")).toHaveValue(/User Memory/u);
		await page.goto(`${fixture.address.origin}/projects/${project.id}/files`);
		await expect(page.locator(".file-list").getByRole("button", { name: /AGENTS\.md/ })).toBeVisible();
		await expect(page.locator(".file-list").getByRole("button", { name: /(?:PROJECT|MEMORY)\.md/ })).toHaveCount(0);
		await page.locator(".file-list").getByRole("button", { name: /AGENTS\.md/ }).click();
		await expect(page.locator(".markdown-preview")).toContainText("项目概况可在一个文件维护");
		await expect(page.locator(".markdown-preview")).toContainText("Python 3.12");
		await expect(page.locator(".markdown-preview")).not.toContainText("workbench-semantic");
		await page.getByRole("button", { name: "编辑", exact: true }).click();
		const editor = page.locator(".file-editor");
		await editor.fill((await editor.inputValue()).replace("项目概况可在一个文件维护", "统一资料已更新"));
		await page.getByRole("button", { name: "保存", exact: true }).click();
		await expect(page.locator(".markdown-preview")).toContainText("统一资料已更新");
		await page.screenshot({ path: "test-results/workspace-canonical-project.png" });
		await page.locator(".project-tabs").getByRole("link", { name: "记忆", exact: true }).click();
		await expect(page.locator(".memory-editor")).toHaveValue(/统一资料已更新/);
		await fixture.restart(); await page.goto(fixture.address.launchUrl); await page.goto(`${fixture.address.origin}/projects/${project.id}/files`);
		await page.locator(".file-list").getByRole("button", { name: /AGENTS\.md/ }).click();
		await expect(page.locator(".markdown-preview")).toContainText("统一资料已更新");
		expect((await readdir(project.workspacePath)).filter((name) => name.endsWith(".md"))).toEqual(["AGENTS.md"]);
		expect(errors).toEqual([]);
	} finally { await fixture.close(); }
});
