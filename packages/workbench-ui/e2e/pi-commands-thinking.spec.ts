import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { createAssistantFixture } from "../../workbench-server/test/assistant-fixture.ts";
import { startModelServer } from "../../workbench-server/test/fixtures/model-server.ts";

test("Pi commands perform real session operations without becoming prompts and retain Skill completion", async ({ page, context }) => {
	const fixture = await createAssistantFixture(fileURLToPath(new URL("../dist", import.meta.url)));
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	try {
		const previous = await fixture.application.createSession({ title: "之前的会话" });
		await page.goto(fixture.address.launchUrl);
		await page.goto(`${fixture.address.origin}/chat?session=${previous.id}`);
		const input = page.getByRole("textbox", { name: "消息输入" });
		const submit = async (text: string, navigates = false) => { await input.fill(text); await page.getByRole("button", { name: "发送消息" }).click(); if (!navigates) await expect(input).toHaveValue(""); };
		await input.fill("/");
		const menu = page.getByRole("listbox", { name: "命令与技能" });
		await expect(menu.getByRole("option").filter({ has: page.locator("strong", { hasText: /^\/new$/ }) })).toBeVisible();
		await expect(menu).toContainText("/compact");
		await expect(menu).toContainText("research");
		await expect(menu).not.toContainText("task_list");
		await page.screenshot({ path: "test-results/pi-slash-menu.png" });
		await input.press("Escape");
		await submit("/new 命令创建的会话");
		await expect(page.locator(".session-item.selected")).toContainText("命令创建的会话");
		const id = new URL(page.url()).searchParams.get("session")!;
		await submit("/name 原生命令会话");
		await expect(page.locator(".session-item.selected")).toContainText("原生命令会话");
		await submit(`/model ${fixture.model.provider}/${fixture.model.id}`);
		await expect(page.getByRole("region", { name: "命令结果" })).toContainText("已选择");
		await submit("/thinking off");
		await expect(page.getByRole("region", { name: "命令结果" })).toContainText("思考强度已设为 off");
		await submit("/session");
		await expect(page.getByRole("region", { name: "命令结果" })).toContainText("用户消息：0");
		fixture.faux.setResponses([fauxAssistantMessage("这是需要复制的实际回复")]);
		await submit("请回复");
		await expect(page.locator(".toolbar-state")).toHaveText("就绪");
		await context.grantPermissions(["clipboard-read", "clipboard-write"]);
		await submit("/copy");
		await expect(page.getByRole("region", { name: "命令结果" })).toContainText("已复制");
		expect(
			await page.evaluate(() =>
				(navigator as unknown as { clipboard: { readText(): Promise<string> } }).clipboard.readText(),
			),
		).toBe("这是需要复制的实际回复");
		const downloading = page.waitForEvent("download");
		await submit("/export jsonl");
		const download = await downloading;
		const content = await readFile((await download.path())!, "utf8");
		expect(content).toContain("这是需要复制的实际回复");
		expect(content).not.toContain("fixture-only");
		await submit("/reload");
		await expect(page.getByRole("region", { name: "命令结果" })).toContainText("重载");
		expect((await fixture.application.services.sessions.get(id)).runtimeSessionId).toBe(JSON.parse(content.split("\n")[0]).id);
		expect((await fixture.application.services.sessions.readTranscript(id)).filter((message) => message.role === "user")).toHaveLength(1);
		await submit("/tree");
		await expect(page.getByRole("region", { name: "命令结果" })).toContainText("Pi CLI");
		await submit("/resume");
		await page.getByRole("region", { name: "选择历史会话" }).getByRole("button", { name: "之前的会话", exact: true }).click();
		await expect(page.locator(".session-item.selected")).toContainText("之前的会话");
		await submit("/settings", true);
		await expect(page.getByRole("heading", { name: "模型设置", exact: true })).toBeVisible();
		expect(errors).toEqual([]);
	} finally { await fixture.close(); }
});

test("the seven-row thinking editor controls chat options and the actual payload after restart", async ({ page }) => {
	const wire = await startModelServer();
	const fixture = await createAssistantFixture(fileURLToPath(new URL("../dist", import.meta.url)));
	try {
		await page.goto(fixture.address.launchUrl);
		await page.goto(`${fixture.address.origin}/settings?section=models`);
		await page.getByRole("button", { name: "添加供应商", exact: true }).click();
		await page.getByLabel("供应商名称", { exact: true }).fill("档位供应商");
		await page.getByLabel("Base URL", { exact: true }).fill(`${wire.origin}/v1`);
		await page.getByLabel("API Key", { exact: true }).fill("fixture-thinking-ui");
		await page.getByRole("button", { name: "添加模型", exact: true }).click();
		await page.getByLabel("模型 ID", { exact: true }).fill("deepseek-flash");
		await page.getByLabel("显示名称", { exact: true }).fill("档位模型");
		await page.getByLabel("思考参数", { exact: true }).selectOption("deepseek");
		await expect(page.getByRole("group", { name: "思考档位" }).getByRole("checkbox")).toHaveCount(7);
		await expect(page.getByLabel("思考参数 minimal", { exact: true })).toBeDisabled();
		await page.getByRole("checkbox", { name: "启用思考档位 low", exact: true }).uncheck();
		await page.getByLabel("思考参数 off", { exact: true }).fill("");
		await page.getByLabel("思考参数 high", { exact: true }).fill("low");
		await page.getByLabel("思考参数 max", { exact: true }).fill("high");
		await page.screenshot({ path: "test-results/thinking-level-editor.png" });
		await page.getByRole("button", { name: "加入列表", exact: true }).click();
		await page.getByRole("button", { name: "保存供应商", exact: true }).click();
		await expect(page.getByRole("button", { name: "保存供应商", exact: true })).toBeDisabled();
		const saved = await fixture.application.services.modelSettings.get();
		const provider = saved.providers.find((entry) => entry.name === "档位供应商")!;
		await page.getByRole("link", { name: "对话", exact: true }).first().click();
		await page.getByRole("combobox", { name: "模型", exact: true }).selectOption(`${provider.id}/deepseek-flash`);
		const thinking = page.getByRole("combobox", { name: "思考强度", exact: true });
		expect(await thinking.locator("option").evaluateAll((items) => items.map((item) => item.getAttribute("value")))).toEqual(["none", "high", "max"]);
		const input = page.getByRole("textbox", { name: "消息输入" });
		await input.fill("/thinking max"); await page.getByRole("button", { name: "发送消息" }).click();
		await expect(thinking).toHaveValue("max");
		await input.fill("验证参数映射"); await page.getByRole("button", { name: "发送消息" }).click();
		await expect.poll(() => wire.requests.at(-1)?.body.reasoning_effort).toBe("high");
		await expect(page.locator(".toolbar-state")).toHaveText("就绪");
		const id = new URL(page.url()).searchParams.get("session")!;
		await fixture.restart();
		await page.goto(fixture.address.launchUrl);
		await page.goto(`${fixture.address.origin}/chat?session=${id}`);
		await expect(thinking).toHaveValue("max");
		await input.fill("/thinking off"); await page.getByRole("button", { name: "发送消息" }).click();
		await expect(thinking).toHaveValue("none");
		await input.fill("验证留空不发送"); await page.getByRole("button", { name: "发送消息" }).click();
		await expect.poll(() => wire.requests.length).toBe(2);
		expect(wire.requests.at(-1)?.body).not.toHaveProperty("reasoning_effort");
		await expect(page.locator(".toolbar-state")).toHaveText("就绪");
		await page.goto(`${fixture.address.origin}/settings?section=models`);
		await page.getByRole("navigation", { name: "模型供应商" }).getByRole("button", { name: "档位供应商" }).click();
		await page.getByRole("button", { name: "编辑", exact: true }).click();
		await expect(page.getByRole("checkbox", { name: "启用思考档位 low", exact: true })).not.toBeChecked();
		await expect(page.getByLabel("思考参数 max", { exact: true })).toHaveValue("high");
		await expect(page.getByLabel("思考参数 off", { exact: true })).toHaveValue("");
	} finally { await fixture.close(); await wire.close(); }
});
