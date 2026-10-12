import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import type { ModelThinkingLevel, RuntimeThinkingLevel } from "@earendil-works/workbench-runtime";
import { createAssistantFixture } from "../../workbench-server/test/assistant-fixture.ts";
import { startModelServer } from "../../workbench-server/test/fixtures/model-server.ts";

const staticRoot = fileURLToPath(new URL("../dist", import.meta.url));

test("all seven thinking selections reach the Responses request and max survives leaving Chat", async ({ page }) => {
	const wire = await startModelServer();
	const fixture = await createAssistantFixture(staticRoot);
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	try {
		const thinkingLevelMap: Record<ModelThinkingLevel, string> = {
			off: "none", minimal: "low", low: "low", medium: "high", high: "high", xhigh: "high", max: "max",
		};
		const settings = await fixture.application.services.modelSettings.save(undefined, {
			name: "DeepSeek 档位验收", api: "openai-responses", baseUrl: `${wire.origin}/v1`,
			enabled: true, apiKey: "fixture-browser-thinking-only",
			expectedVersion: (await fixture.application.services.modelSettings.get()).version,
			models: [{ modelId: "deepseek-flash", name: "DeepSeek Flash", enabled: true, reasoning: true,
				vision: false, contextWindow: 32768, maxTokens: 1024, thinkingPreset: "deepseek", thinkingLevelMap }],
		});
		const provider = settings.providers.find((entry) => entry.name === "DeepSeek 档位验收")!;
		const profile = await fixture.application.services.profiles.getBySlug("standard");
		await page.goto(fixture.address.launchUrl);
		await page.goto(`${fixture.address.origin}/chat?assistant=${profile.id}&draft=1`);
		await page.getByRole("combobox", { name: "模型", exact: true }).selectOption(`${provider.id}/deepseek-flash`);
		const thinking = page.getByRole("combobox", { name: "思考强度", exact: true });
		const input = page.getByRole("textbox", { name: "消息输入" });
		const levels: RuntimeThinkingLevel[] = ["max", "none", "minimal", "low", "medium", "high", "xhigh", "max"];
		for (const [index, level] of levels.entries()) {
			await expect(thinking).toBeEnabled();
			await thinking.selectOption(level);
			await expect(thinking).toHaveValue(level);
			await input.fill(`验证页面选择 ${level}`);
			await page.getByRole("button", { name: "发送消息", exact: true }).click();
			await expect.poll(() => wire.requests.length).toBe(index + 1);
			expect(wire.requests.at(-1)?.body.reasoning).toEqual(
				expect.objectContaining({ effort: thinkingLevelMap[level === "none" ? "off" : level] }),
			);
			await expect(page.locator(".toolbar-state")).toHaveText("就绪");
			await expect(thinking).toHaveValue(level);
		}
		const sessionId = new URL(page.url()).searchParams.get("session")!;
		await page.getByRole("link", { name: "首页", exact: true }).first().click();
		await page.getByRole("link", { name: "对话", exact: true }).first().click();
		await page.locator(".session-item").filter({ hasText: "验证页面选择 max" }).click();
		await expect(page).toHaveURL(new RegExp(`session=${sessionId}`, "u"));
		await expect(thinking).toHaveValue("max");
		await input.fill("继续最高档位");
		await page.getByRole("button", { name: "发送消息", exact: true }).click();
		await expect.poll(() => wire.requests.length).toBe(9);
		expect(wire.requests.at(-1)?.body.reasoning).toEqual(expect.objectContaining({ effort: "max" }));
		await expect(page.locator(".toolbar-state")).toHaveText("就绪");
		expect(errors).toEqual([]);
	} finally {
		await fixture.close();
		await wire.close();
	}
});

test("leaving and returning to an active run with an expired buffer restores silently and keeps Stop working", async ({ page }) => {
	const fixture = await createAssistantFixture(staticRoot, { tokensPerSecond: 1000 });
	try {
		const session = await fixture.application.createSession({ title: "连接恢复验收", profileSlug: "standard" });
		fixture.faux.setResponses([fauxAssistantMessage("持续输出用于验证连接恢复。".repeat(8000))]);
		await page.goto(fixture.address.launchUrl);
		await page.goto(`${fixture.address.origin}/chat?session=${session.id}`);
		await page.getByRole("textbox", { name: "消息输入" }).fill("开始长回复");
		await page.getByRole("button", { name: "发送消息", exact: true }).click();
		await expect(page.locator(".toolbar-state")).toHaveText("执行中");
		await expect(page.locator(".live-message .message-text")).toContainText("持续输出");
		const runId = new URL(page.url()).searchParams.get("run")!;
		await page.getByRole("link", { name: "首页", exact: true }).first().click();
		await expect.poll(() => fixture.application.events.get(runId).latestSequence).toBeGreaterThan(550);
		expect(fixture.application.events.get(runId).completed).toBe(false);
		const replay = fixture.application.events.subscribe(runId)[Symbol.asyncIterator]();
		try {
			expect((await replay.next()).value?.event.type).toBe("stream.reset");
		} finally {
			await replay.return?.();
		}
		await page.getByRole("link", { name: "对话", exact: true }).first().click();
		await page.locator(".session-item").filter({ hasText: session.title }).click();
		await expect(page.locator(".toolbar-state")).toHaveText("执行中");
		await expect(page.locator(".live-message .message-text")).toContainText("持续输出");
		await expect(page.getByRole("alert")).toHaveCount(0);
		await expect(page.getByText("连接已恢复", { exact: false })).toHaveCount(0);
		await page.getByRole("button", { name: "停止执行", exact: true }).click();
		await expect(page.locator(".toolbar-state")).toHaveText("就绪");
		await expect.poll(() => fixture.application.events.get(runId).completed).toBe(true);
	} finally {
		await fixture.close();
	}
});
