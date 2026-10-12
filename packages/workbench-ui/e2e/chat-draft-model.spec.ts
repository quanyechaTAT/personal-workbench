import { fileURLToPath } from "node:url";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { expect, test } from "@playwright/test";
import { createAssistantFixture } from "../../workbench-server/test/assistant-fixture.ts";

test("selecting a model immediately after starting a project draft leaves the previous session unchanged", async ({ page }) => {
	const fixture = await createAssistantFixture(fileURLToPath(new URL("../dist", import.meta.url)));
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	try {
		const settings = await fixture.application.services.modelSettings.get();
		const provider = settings.providers.find((entry) => entry.id === fixture.model.provider)!;
		const secondModel = { ...provider.models[0]!, modelId: "draft-second-model", name: "草稿模型" };
		await fixture.application.services.modelSettings.save(provider.id, {
			name: provider.name, baseUrl: provider.baseUrl, api: provider.api, enabled: true,
			models: [...provider.models, secondModel], expectedVersion: settings.version,
		});
		const project = await fixture.application.createProject({ name: "草稿模型 中文 空格" });
		const previous = await fixture.application.createSession({
			projectId: project.id, profileSlug: "standard",
			model: { provider: fixture.model.provider, modelId: fixture.model.id },
		});
		await page.goto(fixture.address.launchUrl);
		for (let attempt = 0; attempt < 3; attempt++) {
			await page.goto(`${fixture.address.origin}/projects/${project.id}/chat?session=${previous.id}`);
			await expect(page.getByRole("combobox", { name: "模型", exact: true })).toHaveValue(`${provider.id}/${fixture.model.id}`);
			await page.getByRole("button", { name: `新建项目会话 ${project.name}`, exact: true }).click();
			await page.getByRole("combobox", { name: "新会话助手", exact: true }).selectOption(previous.agentProfileId);
			await page.getByRole("button", { name: "开始对话", exact: true }).click();
			// Deliberately omit a route wait: a fast selection must target the new draft.
			await page.getByRole("combobox", { name: "模型", exact: true }).selectOption(`${provider.id}/${secondModel.modelId}`);
			await expect(page).toHaveURL(/draft=1/u);
			await expect(page.getByRole("combobox", { name: "模型", exact: true })).toHaveValue(`${provider.id}/${secondModel.modelId}`);
			expect((await fixture.application.services.sessions.get(previous.id)).model).toEqual(previous.model);
		}
		fixture.faux.setResponses([fauxAssistantMessage("草稿会话模型已正确选择。")]);
		await page.getByRole("textbox", { name: "消息输入", exact: true }).fill("请确认收到消息，不调用工具。");
		await page.getByRole("button", { name: "发送消息", exact: true }).click();
		await expect(page.locator(".conversation-scroll")).toContainText("草稿会话模型已正确选择。");
		await expect(page.locator(".toolbar-state")).toHaveText("就绪");
		const currentId = new URL(page.url()).searchParams.get("session")!;
		expect(currentId).not.toBe(previous.id);
		expect((await fixture.application.services.sessions.get(currentId)).model).toEqual({ provider: provider.id, modelId: secondModel.modelId });
		expect((await fixture.application.services.sessions.get(previous.id)).model).toEqual(previous.model);
		expect(errors).toEqual([]);
	} finally { await fixture.close(); }
});
