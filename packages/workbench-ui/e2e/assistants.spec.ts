import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { createAssistantFixture } from "../../workbench-server/test/assistant-fixture.ts";
import { startRemoteMcpFixture } from "../../workbench-mcp/test/fixtures/remote-server.ts";

const staticRoot = process.env.WORKBENCH_UI_TEST_STATIC_ROOT ?? fileURLToPath(new URL("../dist", import.meta.url));

test("create assistant, import Skill, authorize MCP, run project workflow, restart and continue", async ({ page }) => {
	let projectFolder = "";
	let skillFile = "";
	const fixture = await createAssistantFixture(staticRoot, {
		pickDirectory: async () => projectFolder,
		pickSkillFile: async () => skillFile,
	});
	const remote = await startRemoteMcpFixture({ oauth: true });
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	try {
		await page.goto(fixture.address.launchUrl);
		await page.getByRole("link", { name: "助手", exact: true }).click();
		await page.getByRole("link", { name: "手动创建" }).click();
		await page.getByLabel("名称", { exact: true }).fill("CV Research Assistant");
		await page.getByLabel("系统指令").fill("Follow the CV research workflow and explain the evidence.");
		for (const name of ["写入文件", "创建任务", "提出记忆候选", "注册成果"]) await page.getByRole("checkbox", { name: new RegExp(name) }).check();
		await page.getByRole("button", { name: "保存助手", exact: true }).click();
		await expect(page.getByRole("heading", { name: "CV Research Assistant", exact: true })).toBeVisible();
		const profile = (await fixture.application.services.profiles.list()).find((value) => value.name === "CV Research Assistant")!;

		const source = join(fixture.root, "source", "cv-workflow");
		await mkdir(join(source, "references"), { recursive: true });
		await writeFile(join(source, "SKILL.md"), "---\nname: cv-workflow\ndescription: Structure CV research experiments\n---\nRead references/checklist.md before planning.\n");
		await writeFile(join(source, "references", "checklist.md"), "Record the dataset, baseline and metric.");
		skillFile = join(source, "SKILL.md");
		await page.getByRole("link", { name: "技能", exact: true }).click();
		await page.getByRole("button", { name: "导入技能", exact: true }).click();
		await page.getByRole("button", { name: "选择文件…", exact: true }).click();
		await expect(page.getByLabel("技能文件", { exact: true })).toHaveValue(skillFile);
		await page.getByRole("button", { name: "预览导入" }).click();
		await expect(page.getByRole("checkbox", { name: "cv-workflow" })).toBeVisible();
		await page.getByRole("button", { name: "导入 1 个技能" }).click();
		await expect(page.getByRole("heading", { name: "cv-workflow", exact: true })).toBeVisible();

		await page.getByRole("link", { name: "连接", exact: true }).click();
		await page.getByRole("button", { name: "添加连接" }).click();
		await page.getByLabel("名称", { exact: true }).fill("Local MCP");
		await page.getByRole("combobox", { name: "传输方式", exact: true }).selectOption("stdio");
		await page.getByLabel("命令", { exact: true }).fill(process.execPath);
		await page.getByLabel("参数（JSON 数组）").fill(JSON.stringify([fileURLToPath(new URL("../../workbench-mcp/test/fixtures/stdio-server.mjs", import.meta.url))]));
		await page.getByRole("button", { name: "保存连接" }).click();
		await page.getByRole("button", { name: "运行命令并测试" }).click();
		await expect(page.getByText("连接成功，发现 3 个工具。")).toBeVisible();
		await page.getByRole("button", { name: "添加连接" }).click();
		await page.getByLabel("名称", { exact: true }).fill("OAuth MCP");
		await page.getByLabel("MCP 地址").fill(`${remote.origin}/mcp`);
		await page.getByRole("combobox", { name: "认证方式", exact: true }).selectOption("oauth");
		await page.getByRole("button", { name: "保存连接" }).click();
		await page.getByRole("button", { name: "授权", exact: true }).click();
		await expect(page.getByText("授权已完成。", { exact: false })).toBeVisible();
		await page.getByRole("button", { name: "测试连接", exact: true }).click();
		await expect(page.getByText("连接成功，发现 1 个工具。")).toBeVisible();

		await page.goto(`${fixture.address.origin}/assistants/${profile.id}`);
		await page.getByRole("checkbox", { name: /cv-workflow/ }).check();
		const localTools = page.locator(".connection-capabilities").filter({ has: page.getByRole("heading", { name: /Local MCP/ }) });
		await localTools.getByRole("checkbox", { name: /echo/ }).check();
		await page.getByRole("button", { name: "保存助手", exact: true }).click();
		await expect(page.getByText("版本 2", { exact: true })).toBeVisible();
		await page.getByRole("link", { name: "项目", exact: true }).click();
		projectFolder = join(fixture.root, "CV Learning");
		await mkdir(projectFolder);
		await mkdir(join(projectFolder, "artifacts"));
		await page.getByRole("button", { name: "打开文件夹为项目", exact: true }).click();
		await page.getByRole("button", { name: "浏览文件夹…", exact: true }).click();
		await page.getByRole("button", { name: "创建项目", exact: true }).click();
		await expect(page.locator(".project-title")).toContainText("CV Learning");
		await page.locator(".project-tabs").getByRole("link", { name: "对话", exact: true }).click();
		await page.getByRole("combobox", { name: "助手", exact: true }).selectOption(profile.id);
		const selected = await fixture.application.services.profiles.get(profile.id);
		const project = (await fixture.application.services.projects.list())[0];
		const resolved = await fixture.application.services.capabilities.resolveForSession(selected, project);
		const mcpName = resolved.toolBindings[0].descriptor.name;
		fixture.faux.setResponses([
			(context) => { expect(context.systemPrompt).toContain("CV research workflow"); expect(context.systemPrompt).toContain("cv-workflow"); expect(context.tools?.map((tool) => tool.name)).toContain(mcpName); return fauxAssistantMessage(fauxToolCall(mcpName, { text: "CV evidence" }, { id: "mcp-evidence" }), { stopReason: "toolUse" }); },
			fauxAssistantMessage(fauxToolCall("write", { path: "artifacts/plan.md", content: "# CV Learning\nStart with classification." }, { id: "write-plan" }), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("artifact_register", { type: "document", name: "CV plan", workspaceRelativePath: "artifacts/plan.md" }, { id: "register" }), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("task_create", { title: "Prepare baseline", type: "human", priority: 1 }, { id: "task" }), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("memory_propose", { kind: "project", proposedText: "Use classification as the first baseline.", reason: "Agreed starting point" }, { id: "memory" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("Workbench scenario complete."),
		]);
		await page.locator(".composer textarea").fill("Prepare my CV Learning workspace.");
		await page.getByRole("button", { name: "发送消息" }).click();
		await expect(page.getByRole("button", { name: "批准本次" })).toBeVisible();
		const pendingSessionId = new URL(page.url()).searchParams.get("session")!;
		await page.goto(`${fixture.address.origin}/chat?session=${pendingSessionId}`);
		await page.getByRole("button", { name: "批准本次" }).click();
		await expect(page.getByText("Workbench scenario complete.", { exact: true })).toBeVisible();
		const sessionId = new URL(page.url()).searchParams.get("session")!;
		await page.getByRole("link", { name: "记忆", exact: true }).first().click();
		await page.getByRole("button", { name: "接受", exact: true }).click();
		await expect.poll(async () => (await fixture.application.services.memory.listCandidates())[0]?.status).toBe("accepted");
		expect(await readFile(join(project.workspacePath, "MEMORY.md"), "utf8")).toContain("classification");
		await fixture.restart();
		await page.goto(fixture.address.launchUrl);
		await page.goto(`${fixture.address.origin}/chat?session=${sessionId}`);
		await expect(page.getByText("Workbench scenario complete.", { exact: true })).toBeVisible();
		expect((await fixture.application.services.tasks.list())[0].title).toBe("Prepare baseline");
		expect((await fixture.application.services.artifacts.list())[0].name).toBe("CV plan");
		fixture.faux.setResponses([fauxAssistantMessage(fauxToolCall(mcpName, { text: "resumed" }, { id: "resumed-tool" }), { stopReason: "toolUse" }), fauxAssistantMessage("Continued the same project session.")]);
		await page.locator(".composer textarea").fill("继续这个项目昨天的工作");
		await page.getByRole("button", { name: "发送消息" }).click();
		await page.getByRole("button", { name: "批准本次" }).click();
		await expect(page.getByText("Continued the same project session.", { exact: true })).toBeVisible();
		await page.getByRole("link", { name: "首页", exact: true }).click();
		await page.getByRole("link", { name: "对话", exact: true }).first().click();
		expect(errors).toEqual([]);
	} finally { await fixture.close(); await remote.close(); }
});

test("natural language generates a real Pi draft, which is reviewed and saved in the browser", async ({ page }) => {
	const fixture = await createAssistantFixture(staticRoot);
	try {
		fixture.faux.setResponses([(context) => { expect(context.tools ?? []).toHaveLength(0); return fauxAssistantMessage(JSON.stringify({ name: "Literature Reader", description: "Read evidence", systemPrompt: "Keep references and evidence separate.", tools: ["read"], skillIds: [], mcpBindings: [] })); }]);
		await page.goto(fixture.address.launchUrl);
		await page.getByRole("link", { name: "助手", exact: true }).click();
		await page.getByRole("link", { name: "描述需求生成" }).click();
		await page.getByLabel("你希望助手帮你做什么？").fill("帮我阅读计算机视觉论文");
		await page.getByRole("button", { name: "生成草稿" }).click();
		await expect(page.getByLabel("名称", { exact: true })).toHaveValue("Literature Reader");
		await page.getByLabel("名称", { exact: true }).fill("My CV Reader");
		await page.getByRole("button", { name: "创建这个助手" }).click();
		await expect(page.getByRole("heading", { name: "My CV Reader", exact: true })).toBeVisible();
	} finally { await fixture.close(); }
});
