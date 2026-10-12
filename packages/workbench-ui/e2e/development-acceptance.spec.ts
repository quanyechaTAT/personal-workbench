import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { expect, test } from "@playwright/test";
import { createAssistantFixture } from "../../workbench-server/test/assistant-fixture.ts";

const staticRoot = process.env.WORKBENCH_UI_TEST_STATIC_ROOT ?? fileURLToPath(new URL("../dist/public", import.meta.url));

for (const accepted of [false, true]) {
	test(`development evidence stays internal when ${accepted ? "accepted" : "unverified"}, including after reload`, async ({ page }) => {
		const fixture = await createAssistantFixture(staticRoot);
		const errors: string[] = [];
		page.on("pageerror", (error) => errors.push(error.message));
		try {
			const session = await fixture.application.createSession({ profileSlug: "standard" });
			await fixture.application.services.permissions.setMode(session.id, "full-access");
			fixture.faux.setResponses([
				fauxAssistantMessage(fauxToolCall("write", { path: "feature.txt", content: "implemented" }), { stopReason: "toolUse" }),
				...(accepted ? [
					fauxAssistantMessage(fauxToolCall("verify_changes", {
						command: "if ((Get-Content feature.txt) -ne 'implemented') { exit 1 }; Write-Output verified-feature; exit 0",
					}, { id: "feature-check" }), { stopReason: "toolUse" }),
					fauxAssistantMessage(fauxToolCall("accept_changes", { criteria: [{
						requirement: "功能文件包含实现", checkIds: ["feature-check"], evidence: "真实读取文件并核对内容匹配",
					}] }), { stopReason: "toolUse" }),
				] : []),
				fauxAssistantMessage("功能已完成"),
			]);
			await page.goto(fixture.address.launchUrl);
			await page.goto(`${fixture.address.origin}/chat?session=${session.id}`);
			await page.getByRole("textbox", { name: "消息输入" }).fill("实现功能并验收");
			await page.getByRole("button", { name: "发送消息", exact: true }).click();
			const progress = page.getByRole("region", { name: "开发流程", exact: true });
			await expect(page.locator(".toolbar-state")).toHaveText("就绪");
			await expect(page.locator(".conversation-scroll")).toContainText("功能已完成");
			await expect(progress).toHaveCount(0);
			await expect(page.locator(".development-status")).toHaveCount(0);
			const state = await fixture.application.services.sessions.readDevelopmentState(session.id);
			expect(state?.acceptance.status).toBe(accepted ? "accepted" : "needs_verification");
			await page.reload();
			await expect(page.locator(".conversation-scroll")).toContainText("功能已完成");
			await expect(progress).toHaveCount(0);
			if (accepted) expect(state?.checks[0].output).toContain("verified-feature");
			expect(errors).toEqual([]);
		} finally {
			await fixture.close();
		}
	});
}

test("direct HTML generation with forbidden tests stays free of acceptance panels after reload", async ({ page }) => {
	const fixture = await createAssistantFixture(staticRoot);
	try {
		const session = await fixture.application.createSession({ profileSlug: "standard" });
		await fixture.application.services.permissions.setMode(session.id, "full-access");
		fixture.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("write", { path: "pelican-bicycle.html", content: "<!doctype html><svg></svg>" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("已生成 HTML，按要求未测试。"),
		]);
		await page.goto(fixture.address.launchUrl);
		await page.goto(`${fixture.address.origin}/chat?session=${session.id}`);
		await page.getByRole("textbox", { name: "消息输入" }).fill("创建一个HTML，用SVG绘制鹈鹕骑自行车动画，你不能进行任何测试，不能调用skills，不能网络检索，不能调用子智能体，直接生成");
		await page.getByRole("button", { name: "发送消息", exact: true }).click();
		await expect(page.locator(".conversation-scroll")).toContainText("已生成 HTML，按要求未测试。");
		await expect(page.locator(".toolbar-state")).toHaveText("就绪");
		await expect(page.getByRole("region", { name: "开发流程", exact: true })).toHaveCount(0);
		await expect(page.locator(".conversation-scroll")).not.toContainText("待验收");
		await page.reload();
		await expect(page.locator(".conversation-scroll")).toContainText("已生成 HTML，按要求未测试。");
		await expect(page.getByRole("region", { name: "开发流程", exact: true })).toHaveCount(0);
	} finally { await fixture.close(); }
});
