import { fileURLToPath } from "node:url";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { createCanvas } from "@napi-rs/canvas";
import { expect, test, type Page } from "@playwright/test";
import { createAssistantFixture } from "../../workbench-server/test/assistant-fixture.ts";
import { docxDocument, pdfDocument } from "../../workbench-server/test/fixtures/knowledge-documents.ts";

async function pasteImage(page: Page) {
	const canvas = createCanvas(50, 30);
	const context = canvas.getContext("2d");
	context.fillStyle = "#ee3344";
	context.fillRect(5, 5, 20, 20);
	await page.evaluate(async (base64) => {
		const browser = globalThis as unknown as {
			navigator: { clipboard: { write(items: unknown[]): Promise<void> } };
			ClipboardItem: new (items: Record<string, Blob>) => unknown;
		};
		const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
		await browser.navigator.clipboard.write([new browser.ClipboardItem({ "image/png": new Blob([bytes], { type: "image/png" }) })]);
	}, canvas.toBuffer("image/png").toString("base64"));
	await page.getByRole("textbox", { name: "消息输入", exact: true }).focus();
	await page.keyboard.press("Control+V");
	await expect(page.getByRole("region", { name: "本轮附件" }).locator("img")).toHaveCount(1);
}

test("clipboard paste and @ file chooser send real images/document content, restore previews after refresh/restart, and isolate sessions", async ({ page, context }) => {
	const fixture = await createAssistantFixture(fileURLToPath(new URL("../dist", import.meta.url)), { modelInput: ["text", "image"] });
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	try {
		await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: fixture.address.origin });
		const project = await fixture.application.createProject({ name: "聊天附件 浏览器 中文" });
		const profile = (await fixture.application.services.profiles.list()).find((item) => item.slug === "standard")!;
		await page.goto(fixture.address.launchUrl);
		await page.goto(`${fixture.address.origin}/projects/${project.id}/chat?assistant=${profile.id}&draft=1`);
		await expect(page.getByRole("combobox", { name: "助手", exact: true })).toHaveValue(profile.id);
		const input = page.getByRole("textbox", { name: "消息输入", exact: true });
		await input.fill("请读取附件 @");
		await expect(page.getByRole("listbox", { name: "文件上传", exact: true })).toBeVisible();
		const chooser = page.waitForEvent("filechooser");
		await input.press("Enter");
		await (await chooser).setFiles([
			{ name: "附件 中文 空格.txt", mimeType: "text/plain", buffer: Buffer.from("订单 CHAT-882 共有 17 本书。") },
			{ name: "Word 中文.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", buffer: await docxDocument("运费是 9 元。") },
			{ name: "Page report.pdf", mimeType: "application/pdf", buffer: pdfDocument(["PDF invoice 620"]) },
		]);
		await expect(input).toHaveValue("请读取附件 ");
		await expect(page.getByRole("region", { name: "本轮附件" })).toContainText("附件 中文 空格.txt");
		await pasteImage(page);
		let observed = false;
		fixture.faux.setResponses([(modelContext) => {
			expect(JSON.stringify(modelContext.messages)).toContain("CHAT-882");
			expect(JSON.stringify(modelContext.messages)).toContain("运费是 9 元");
			expect(JSON.stringify(modelContext.messages)).toContain("PDF invoice 620");
			expect(JSON.stringify(modelContext.messages)).toContain('"type":"image"');
			observed = true;
			return fauxAssistantMessage("看到了图片，订单有 17 本书，运费 9 元，PDF 编号 620。");
		}]);
		await page.getByRole("button", { name: "发送消息", exact: true }).click();
		await expect(page.locator(".conversation-scroll")).toContainText("订单有 17 本书");
		await expect(page.locator(".toolbar-state")).toHaveText("就绪");
		expect(observed).toBe(true);
		const sessionId = new URL(page.url()).searchParams.get("session")!;
		await expect(page.getByRole("region", { name: "本轮附件" })).toHaveCount(0);
		await expect(page.getByRole("img", { name: "上传的图片", exact: true })).toBeVisible();
		await expect(page.getByRole("region", { name: "消息附件" })).toContainText("附件 中文 空格.txt");
		await page.reload();
		await expect(page.getByRole("img", { name: "上传的图片", exact: true })).toBeVisible();
		await fixture.restart();
		await page.goto(fixture.address.launchUrl);
		await page.goto(`${fixture.address.origin}/projects/${project.id}/chat?session=${sessionId}`);
		await expect(page.getByRole("region", { name: "消息附件" })).toContainText("Word 中文.docx");
		await expect(page.getByRole("img", { name: "上传的图片", exact: true })).toBeVisible();
		const other = await fixture.application.createSession({ projectId: project.id });
		await page.goto(`${fixture.address.origin}/projects/${project.id}/chat?session=${other.id}`);
		await expect(page.locator(".toolbar-state")).toHaveText("就绪");
		await expect(page.getByRole("region", { name: "消息附件" })).toHaveCount(0);
		expect(await fixture.application.services.knowledge.listDocuments(project)).toEqual([]);
		expect(errors).toEqual([]);
	} finally { await fixture.close(); }
});

test("image-only input, removing drafts, literal emails, @ escape, validation errors and text-only capability feedback", async ({ page, context }) => {
	const fixture = await createAssistantFixture(fileURLToPath(new URL("../dist", import.meta.url)), { modelInput: ["text", "image"] });
	try {
		await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: fixture.address.origin });
		const session = await fixture.application.createSession({ profileSlug: "standard" });
		await page.goto(fixture.address.launchUrl);
		await page.goto(`${fixture.address.origin}/chat?session=${session.id}`);
		const input = page.getByRole("textbox", { name: "消息输入", exact: true });
		await input.fill("name@example.com");
		await expect(page.getByRole("listbox", { name: "文件上传" })).toHaveCount(0);
		await input.fill("@");
		await expect(page.getByRole("listbox", { name: "文件上传" })).toBeVisible();
		await input.press("Escape");
		await expect(page.getByRole("listbox", { name: "文件上传" })).toHaveCount(0);
		await input.fill("");
		await pasteImage(page);
		await page.getByRole("button", { name: /移除附件/u }).click();
		await expect(page.getByRole("region", { name: "本轮附件" })).toHaveCount(0);
		await expect(page.getByRole("button", { name: "发送消息", exact: true })).toBeDisabled();
		await pasteImage(page);
		fixture.faux.setResponses([fauxAssistantMessage("收到纯图片消息。")]);
		await page.getByRole("button", { name: "发送消息", exact: true }).click();
		await expect(page.locator(".conversation-scroll")).toContainText("收到纯图片消息。");
		await expect(page.locator(".toolbar-state")).toHaveText("就绪");
		await input.fill("请读文件 @");
		const chooser = page.waitForEvent("filechooser");
		await page.getByRole("option", { name: /上传文件/u }).click();
		await (await chooser).setFiles({ name: "损坏的 Word.docx", mimeType: "application/octet-stream", buffer: Buffer.from("broken archive") });
		await page.getByRole("button", { name: "发送消息", exact: true }).click();
		await expect(page.locator(".conversation-scroll")).toContainText("DOCX");
		await expect(input).toHaveValue("请读文件");
		await expect(page.getByRole("region", { name: "本轮附件" })).toContainText("损坏的 Word.docx");
		await page.getByRole("button", { name: /移除附件/u }).click();
		const settings = await fixture.application.services.modelSettings.get();
		const provider = settings.providers.find((item) => item.id === fixture.model.provider)!;
		await fixture.application.services.modelSettings.save(provider.id, { name: provider.name, baseUrl: provider.baseUrl, api: provider.api, enabled: true, models: provider.models.map((model) => ({ ...model, vision: false })), expectedVersion: settings.version });
		await page.reload();
		await pasteImage(page);
		await expect(page.locator(".composer-wrap")).toContainText("当前模型未启用图片输入");
		await expect(page.getByRole("button", { name: "发送消息", exact: true })).toBeDisabled();
	} finally { await fixture.close(); }
});

test("cancelling an upload preserves the draft and cannot silently enqueue attachments during a run", async ({ page }) => {
	const fixture = await createAssistantFixture(fileURLToPath(new URL("../dist", import.meta.url)), { tokensPerSecond: 8 });
	try {
		const session = await fixture.application.createSession({ profileSlug: "standard" });
		await page.goto(fixture.address.launchUrl);
		await page.goto(`${fixture.address.origin}/chat?session=${session.id}`);
		const input = page.getByRole("textbox", { name: "消息输入", exact: true });
		await input.fill("请读 @");
		const chooser = page.waitForEvent("filechooser");
		await input.press("Enter");
		await (await chooser).setFiles({ name: "可取消.txt", mimeType: "text/plain", buffer: Buffer.from("cancel test") });
		let unblock: () => void = () => undefined;
		const blocked = new Promise<void>((resolve) => { unblock = resolve; });
		await page.route("**/attachments?*", async (route) => { await blocked; await route.abort(); });
		await page.getByRole("button", { name: "发送消息", exact: true }).click();
		await expect(page.getByRole("status")).toContainText("正在上传附件");
		await page.getByRole("button", { name: "取消发送", exact: true }).click();
		unblock();
		await expect(input).toHaveValue("请读");
		await expect(page.getByRole("region", { name: "本轮附件" })).toContainText("可取消.txt");
		expect(await fixture.application.services.sessions.readTranscript(session.id)).toEqual([]);
		await page.unroute("**/attachments?*");
		await page.getByRole("button", { name: /移除附件/u }).click();
		fixture.faux.setResponses([fauxAssistantMessage("普通文本消息继续执行，等待用户补充。".repeat(8))]);
		await input.fill("文本任务");
		await page.getByRole("button", { name: "发送消息", exact: true }).click();
		await expect(page.getByRole("button", { name: "停止执行", exact: true })).toBeVisible();
		await input.fill("@");
		const during = page.waitForEvent("filechooser");
		await input.press("Enter");
		await (await during).setFiles({ name: "稍后发送.txt", mimeType: "text/plain", buffer: Buffer.from("follow-up attachment") });
		await expect(page.locator(".composer-wrap")).toContainText("附件暂不支持加入消息队列");
		await expect(page.getByRole("button", { name: "加入消息队列", exact: true })).toBeDisabled();
		await page.getByRole("button", { name: "停止执行", exact: true }).click();
		await expect(page.locator(".toolbar-state")).toHaveText("就绪");
		await expect(page.getByRole("region", { name: "本轮附件" })).toContainText("稍后发送.txt");
	} finally { await fixture.close(); }
});

test("a project chat started from the global sidebar keeps its scope across refresh and uploads into that project session", async ({ page }) => {
	const fixture = await createAssistantFixture(fileURLToPath(new URL("../dist", import.meta.url)));
	try {
		const project = await fixture.application.createProject({ name: "刷新后项目附件" });
		const profile = (await fixture.application.services.profiles.list()).find((item) => item.slug === "standard")!;
		await page.goto(fixture.address.launchUrl);
		await page.goto(`${fixture.address.origin}/chat?assistant=${profile.id}&draft=1`);
		await page.getByRole("button", { name: `新建项目会话 ${project.name}`, exact: true }).click();
		await page.getByRole("combobox", { name: "新会话助手", exact: true }).selectOption(profile.id);
		await page.getByRole("button", { name: "开始对话", exact: true }).click();
		await expect(page).toHaveURL(new RegExp(`/projects/${project.id}/chat\\?`));
		await page.reload();
		await expect(page.getByRole("combobox", { name: "助手", exact: true })).toHaveValue(profile.id);
		const input = page.getByRole("textbox", { name: "消息输入", exact: true });
		await input.fill("请读本项目附件 @");
		const chooser = page.waitForEvent("filechooser");
		await input.press("Enter");
		await (await chooser).setFiles({ name: "项目范围.txt", mimeType: "text/plain", buffer: Buffer.from("PROJECT-SCOPE-328") });
		fixture.faux.setResponses([(modelContext) => {
			expect(JSON.stringify(modelContext.messages)).toContain("PROJECT-SCOPE-328");
			return fauxAssistantMessage("项目附件已读取。");
		}]);
		await page.getByRole("button", { name: "发送消息", exact: true }).click();
		await expect(page.locator(".conversation-scroll")).toContainText("项目附件已读取");
		const id = new URL(page.url()).searchParams.get("session")!;
		expect((await fixture.application.services.sessions.get(id)).projectId).toBe(project.id);
		await expect(page.getByRole("region", { name: "消息附件", exact: true })).toContainText("项目范围.txt");
	} finally { await fixture.close(); }
});
