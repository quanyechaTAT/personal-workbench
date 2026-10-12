import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { createPerceptionFixture, imageDocument } from "../../workbench-server/test/perception-fixture.ts";

test("upload quota degradation, explicit model-description review and configurable overlap work in the browser", async ({ page }) => {
	const setup = await createPerceptionFixture(fileURLToPath(new URL("../dist", import.meta.url)));
	try {
		setup.setProviderErrors("AllocationQuota.FreeTierOnly");
		const project = await setup.project("浏览器多模态修复");
		await page.goto(setup.fixture.address.launchUrl);
		await page.goto(`${setup.fixture.address.origin}/projects/${project.id}/knowledge`);
		await page.getByLabel("上传知识文档").setInputFiles({ name: "额度截图.png", mimeType: "image/png", buffer: imageDocument() });
		await expect(page.getByRole("region", { name: "已上传文档" })).toContainText("AllocationQuota.FreeTierOnly");
		await expect(page.getByRole("region", { name: "图像描述人工核对" })).toContainText("模型生成");
		await page.getByRole("button", { name: "我已对照原件核对图像描述" }).click();
		await expect(page.getByRole("region", { name: "图像描述人工核对" })).toContainText("已由用户核对");
		await page.getByText("分块与检索参数", { exact: true }).click();
		await page.getByLabel("相邻片段重叠 Token").fill("32");
		await page.getByRole("button", { name: "保存参数", exact: true }).click();
		await expect.poll(async () => (await setup.fixture.application.services.knowledge.settings(project)).overlapTokens).toBe(32);
		await page.reload();
		await page.getByRole("button", { name: "额度截图.png", exact: false }).click();
		await expect(page.getByRole("region", { name: "图像描述人工核对" })).toContainText("已由用户核对");
	} finally { await setup.close(); }
});
