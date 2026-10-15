import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { expect, test } from "@playwright/test";
import { createAssistantFixture } from "../../workbench-server/test/assistant-fixture.ts";

const staticRoot = process.env.WORKBENCH_UI_TEST_STATIC_ROOT ?? fileURLToPath(new URL("../dist", import.meta.url));

test("queued messages restore after reload and support edit, removal and immediate steering", async ({ page }) => {
	const fixture = await createAssistantFixture(staticRoot);
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	try {
		const session = await fixture.application.createSession({ profileSlug: "standard" });
		fixture.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("powershell", { command: "Write-Output wait" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("本项请求已处理"), fauxAssistantMessage("已处理排队消息"),
		]);
		await page.goto(fixture.address.launchUrl);
		await page.goto(`${fixture.address.origin}/chat?session=${session.id}`);
		const input = page.getByRole("textbox", { name: "消息输入", exact: true });
		await input.fill("初始任务");
		await page.getByRole("button", { name: "发送消息", exact: true }).click();
		await expect(page.getByRole("button", { name: "批准本次", exact: true })).toBeVisible();
		for (const text of ["待修改任务", "待删除任务", "立即补充"]) { await input.fill(text); await input.press("Enter"); await expect(input).toHaveValue(""); }
		await page.reload();
		const dock = page.getByRole("region", { name: "排队消息", exact: true });
		await expect(dock).toContainText("3 条消息排队中");
		await dock.getByRole("button", { name: /3 条消息排队中/ }).click();
		let row = dock.locator(".queue-row").filter({ hasText: "待修改任务" });
		await row.getByRole("button", { name: "编辑排队消息", exact: true }).click();
		await row.getByRole("textbox", { name: "编辑消息内容", exact: true }).fill("修改后的任务");
		await dock.getByRole("button", { name: "保存排队消息", exact: true }).click();
		await expect(dock).toContainText("修改后的任务");
		row = dock.locator(".queue-row").filter({ hasText: "待删除任务" });
		await row.getByRole("button", { name: "删除排队消息", exact: true }).click();
		await expect(dock).not.toContainText("待删除任务");
		row = dock.locator(".queue-row").filter({ hasText: "立即补充" });
		await row.getByRole("button", { name: "立即发送排队消息", exact: true }).click();
		await expect(dock).not.toContainText("立即补充");
		await expect(page.getByRole("region", { name: "等待送达的指令", exact: true })).toContainText("立即补充");
		await page.getByRole("button", { name: "拒绝", exact: true }).click();
		await expect(page.locator(".toolbar-state")).toHaveText("就绪");
		await expect(dock).toHaveCount(0);
		const transcript = await fixture.application.services.sessions.readTranscript(session.id);
		expect(transcript.filter((entry) => entry.role === "user").map((entry) => entry.content[0].text)).toEqual(["初始任务", "立即补充", "修改后的任务"]);
		expect(errors).toEqual([]);
	} finally { await fixture.close(); }
});
