import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { expect, test } from "@playwright/test";
import { createAssistantFixture } from "../../workbench-server/test/assistant-fixture.ts";

test("configure HyDE, show its non-evidence document and source matches, and inspect the selected conversation LLM", async ({ page }) => {
	const fixture = await createAssistantFixture(fileURLToPath(new URL("../dist", import.meta.url)));
	const embedding = createServer(async (request, response) => {
		let body = "";
		for await (const chunk of request) body += chunk.toString();
		const { input } = JSON.parse(body) as { input: string[] };
		response.setHeader("content-type", "application/json");
		response.end(JSON.stringify({ data: input.map((_text, index) => ({ index, embedding: [1, 0] })) }));
	});
	await new Promise<void>((resolve) => embedding.listen(0, "127.0.0.1", resolve));
	try {
		const address = embedding.address();
		if (!address || typeof address === "string") throw new Error("No embedding fixture port");
		await writeFile(fixture.embeddingEnvFile, `EMBED_API_KEY=test-only\nEMBED_BASE_URL=http://127.0.0.1:${address.port}/v1\nEMBED_MODEL_NAME=hyde-browser\nEMBED_TOKENIZER=cl100k_base\nEMBED_TOKENIZER_MODEL=hyde-browser\n`);
		const sourcePath = join(fixture.root, "HyDE 浏览器项目");
		await mkdir(sourcePath);
		await writeFile(join(sourcePath, "facts.md"), "# 混合检索\n\n稀疏索引匹配机制与真实证据引用。");
		const project = await fixture.application.createProject({ sourcePath });
		await fixture.application.services.knowledge.index(project);
		await page.goto(fixture.address.launchUrl);
		await page.goto(`${fixture.address.origin}/projects/${project.id}/knowledge`);
		await page.getByText("分块与检索参数", { exact: true }).click();
		await page.getByLabel("多查询扩展（MQE）").selectOption("off");
		await page.getByLabel("假设文档召回（HyDE）").selectOption("always");
		await page.getByRole("button", { name: "保存参数" }).click();
		await expect.poll(async () => (await fixture.application.services.knowledge.settings(project)).hyde).toBe("always");
		const hypothesis = "混合检索可能结合稀疏索引匹配机制和向量召回。假设浏览器标记仅供检索测试，实际回答需要真实文档来源。";
		fixture.faux.setResponses([fauxAssistantMessage(JSON.stringify({ document: hypothesis }))]);
		await page.getByLabel("检索项目资料").fill("混合检索");
		await page.getByRole("button", { name: "检索", exact: true }).click();
		await expect(page.getByRole("region", { name: "HyDE 检索记录" })).toContainText("已用于召回");
		await page.getByText(/假设检索文档（非证据）/).click();
		await expect(page.locator(".hyde-trace pre")).toContainText("假设浏览器标记");
		await expect(page.locator(".knowledge-result")).toContainText("HyDE 向量");
		await expect(page.locator(".knowledge-result")).not.toContainText("假设浏览器标记");
		const session = await fixture.application.createSession({ projectId: project.id, model: { provider: fixture.model.provider, modelId: fixture.model.id } });
		fixture.faux.setResponses([fauxAssistantMessage(JSON.stringify({ document: hypothesis }))]);
		await fixture.application.contextForSession(session.id, "混合检索");
		await page.goto(`${fixture.address.origin}/projects/${project.id}/chat?session=${session.id}`);
		await page.getByRole("button", { name: "会话详情", exact: true }).click();
		await expect(page.getByRole("region", { name: "HyDE 检索记录" })).toContainText(fixture.model.id);
		await expect(page.getByRole("region", { name: "HyDE 检索记录" })).toContainText("已用于召回");
	} finally {
		await fixture.close();
		embedding.closeAllConnections();
		await new Promise<void>((resolve, reject) => embedding.close((error) => error ? reject(error) : resolve()));
	}
});
