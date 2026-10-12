import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { createAssistantFixture } from "../../workbench-server/test/assistant-fixture.ts";

const staticRoot = process.env.WORKBENCH_UI_TEST_STATIC_ROOT ?? fileURLToPath(new URL("../dist", import.meta.url));

test("legacy builtin skills show Chinese titles with no naming warnings after restart", async ({ page }) => {
	const fixture = await createAssistantFixture(staticRoot);
	try {
		for (const [slug, name] of [["coding", "Coding"], ["project-planning", "Project Planning"], ["research", "Research"], ["weekly-review", "Weekly Review"]]) {
			const path = join(fixture.application.paths.skills, slug, "SKILL.md");
			await writeFile(path, (await readFile(path, "utf8")).replace(`name: ${slug}`, `name: ${name}`));
		}
		await fixture.restart();
		await page.goto(fixture.address.launchUrl);
		await page.goto(`${fixture.address.origin}/skills`);
		await expect(page.locator(".skill-card")).toHaveCount(4);
		for (const name of ["代码开发", "项目规划", "资料研究", "每周回顾"]) await expect(page.getByRole("heading", {name, exact: true})).toBeVisible();
		await expect(page.locator(".skill-grid")).not.toContainText("name contains invalid");
		const skills = await fixture.application.services.skills.list();
		expect(skills.every((skill) => skill.diagnostics.length === 0)).toBe(true);
	} finally { await fixture.close(); }
});
