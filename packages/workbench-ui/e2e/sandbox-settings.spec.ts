import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { createAssistantFixture } from "../../workbench-server/test/assistant-fixture.ts";

const staticRoot = process.env.WORKBENCH_UI_TEST_STATIC_ROOT ?? fileURLToPath(new URL("../dist", import.meta.url));

test("sandbox settings persist, use the native folder picker and keep approval separate", async ({ page }) => {
	let directory = "";
	const fixture = await createAssistantFixture(staticRoot, { pickDirectory: async () => directory });
	try {
		directory = join(fixture.root, "额外可写目录");
		await mkdir(directory);
		await page.goto(fixture.address.launchUrl);
		await page.goto(`${fixture.address.origin}/settings?section=sandbox`);
		await expect(page.getByRole("combobox", { name: "沙箱执行模式" })).toHaveValue("workspace-write");
		await expect(page.getByLabel("允许沙箱命令联网").locator("input")).not.toBeChecked();
		await page.getByRole("button", { name: "添加可写目录…" }).click();
		await expect(page.locator(".settings-content")).toContainText(directory);
		await page.getByRole("combobox", { name: "沙箱执行模式" }).selectOption("read-only");
		await expect.poll(async () => (await fixture.application.services.settings.get("sandbox.policy"))?.value).toMatchObject({ mode: "read-only", networkAccess: false, writableRoots: [directory] });
		await page.reload();
		await expect(page.getByRole("combobox", { name: "沙箱执行模式" })).toHaveValue("read-only");
		await expect(page.getByRole("button", { name: "添加可写目录…" })).toBeDisabled();
		await fixture.restart();
		await page.goto(fixture.address.launchUrl);
		await page.goto(`${fixture.address.origin}/settings?section=sandbox`);
		await expect(page.getByRole("combobox", { name: "沙箱执行模式" })).toHaveValue("read-only");
		await page.getByRole("combobox", { name: "沙箱执行模式" }).selectOption("danger-full-access");
		await expect(page.getByLabel("允许沙箱命令联网").locator("input")).toBeChecked();
		await expect(page.getByLabel("允许沙箱命令联网").locator("input")).toBeDisabled();
		await expect(page.locator(".settings-content")).toContainText("当前已关闭操作系统沙箱");
	} finally { await fixture.close(); }
});
