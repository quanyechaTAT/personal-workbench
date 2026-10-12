import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { createAssistantFixture } from "../../workbench-server/test/assistant-fixture.ts";

test("rollback approval displays the historical text that will actually be restored", async ({ page }) => {
	const fixture = await createAssistantFixture(fileURLToPath(new URL("../dist", import.meta.url)));
	try {
		const project = await fixture.application.createProject({ name: "回滚审核 中文 空格" });
		const memory = fixture.application.services.memory;
		const original = await memory.propose({ project }, {
			kind: "project", proposedText: "项目使用 Python 3.12。", reason: "用户确认",
		});
		await memory.accept(original.id);
		const update = await memory.propose({ project }, {
			kind: "project", proposedText: "项目使用 Python 3.13。", reason: "用户更新",
			semanticChange: { operation: "update", targetId: original.id, expectedVersion: 1 },
		});
		await memory.accept(update.id);
		// Version operations remain available through the Gateway after removal of the four-layer panel.
		const rollback = await fixture.request("/memory/semantic/proposals", { method: "POST", body: JSON.stringify({
			kind: "project", projectId: project.id, proposedText: "回滚", reason: "恢复用户确认的项目版本",
			semanticChange: { operation: "rollback", targetId: original.id, expectedVersion: 2, rollbackVersion: 1 },
		}) });
		expect(rollback.status).toBe(201);
		await page.goto(fixture.address.launchUrl);
		await page.goto(`${fixture.address.origin}/memory`);
		await expect(page.getByRole("heading", { name: "四层记忆", exact: true })).toHaveCount(0);
		await page.locator(".memory-library aside button").filter({ hasText: `projects/${project.slug}/AGENTS.md` }).click();
		const editor = page.locator(".memory-library > section > textarea");
		await expect(editor).toHaveValue(/项目使用 Python 3\.13。/);
		const candidate = page.locator(".candidate-card");
		await expect(candidate.locator("p")).toHaveText("项目使用 Python 3.12。");
		await candidate.getByRole("button", { name: "接受", exact: true }).click();
		await expect(candidate).toHaveCount(0);
		await expect(editor).toHaveValue(/项目使用 Python 3\.12。/);
		const versions = await fixture.application.services.semantic.history(original.id, { project });
		expect(versions.map((version) => [version.version, version.text])).toEqual([
			[3, "项目使用 Python 3.12。"], [2, "项目使用 Python 3.13。"], [1, "项目使用 Python 3.12。"],
		]);
	} finally { await fixture.close(); }
});
