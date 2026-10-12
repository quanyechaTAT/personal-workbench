// Explicit, opt-in acceptance against configured Pi credentials; never run by CI.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createWorkbenchApplication } from "../dist/application.js";

const providerIndex = process.argv.indexOf("--provider");
const provider = providerIndex >= 0 ? process.argv[providerIndex + 1] : undefined;
if (!provider) throw new Error("Usage: node packages/workbench-server/scripts/acceptance-live.mjs --provider <configured-provider>");
const root = await mkdtemp(join(tmpdir(), "workbench-live 中文 "));
let app;
try {
	app = await createWorkbenchApplication({dataRoot: root});
	const models = (await app.runtime.listModels()).filter((model) => model.available && model.provider === provider);
	const model = models.find((entry) => !entry.reasoning) ?? models[0];
	assert.ok(model, `No configured model for ${provider}`);
	const project = await app.createProject({name: "CV Learning", description: "Isolated acceptance workspace"});
	const connection = await app.services.connections.create({name: "Acceptance echo", transport: "stdio", authKind: "none", stdio: {command: process.execPath, args: [fileURLToPath(new URL("../../workbench-mcp/test/fixtures/stdio-server.mjs", import.meta.url))], environmentKeys: []}});
	const echo = (await app.services.connections.test(connection.id)).tools.find((tool) => tool.name === "echo");
	assert.ok(echo);
	const skill = await app.services.skills.create({slug: "acceptance-workflow", name: "Acceptance workflow", description: "Verify project artifacts and record explicit decisions", instructions: "Use selected tools to complete the request. Only propose memory; the user reviews it.", scope: "global"});
	const profile = await app.services.profiles.create({name: "Live CV Assistant", systemPrompt: "You are a CV project assistant. Execute the user's concrete requested tools, then report their results. Do not invent files, memory, or task IDs.", defaultModel: {provider: model.provider, modelId: model.modelId}, tools: ["read", "write", "artifact_register", "task_create", "task_list", "memory_propose"], skillIds: [skill.id], mcpBindings: [{connectionId: connection.id, toolName: "echo", approvedDefinitionHash: echo.definitionHash, approval: "allow"}]});
	const session = await app.createSession({projectId: project.id, profileId: profile.id});
	const normalized = (await app.services.capabilities.resolveForSession(profile, project)).toolBindings[0].descriptor.name;
	async function run(text) {
		const context = await app.contextForSession(session.id, text);
		const started = app.events.start(session.id, {text, context: context.runtime, turnContext: context.turn});
		const events = [];
		const timeout = setTimeout(() => void app.events.abort(session.id), 180_000);
		try { for await (const entry of app.events.subscribe(started.runId)) events.push(entry.event); }
		finally { clearTimeout(timeout); }
		assert.ok(events.some((event) => event.type === "run.completed"), "Real model run did not complete");
		return events;
	}
	const first = await run(`请实际执行以下验收操作，每项只执行一次：1. 调用 ${normalized}，text="CV acceptance"。2. write 创建 artifacts/acceptance.md，内容包含 CV baseline。3. artifact_register 注册该文件，workspaceRelativePath="projects/cv-learning/artifacts/acceptance.md"，name="CV acceptance"，type="report"。4. task_create 创建 human 任务“Prepare CV baseline”。5. memory_propose 提议 project memory “Use classification as the first baseline.”，说明理由。最后简短总结，不能只提供操作建议。`);
	assert.ok(first.some((event) => event.type === "message.text.delta"), "Missing real streaming text");
	assert.ok(first.some((event) => event.type === "tool.completed" && event.data.toolName === normalized && !event.data.isError), "MCP tool not executed");
	assert.match(await readFile(join(project.workspacePath, "artifacts", "acceptance.md"), "utf8"), /CV baseline/iu);
	assert.ok((await app.services.tasks.list({projectId: project.id})).length);
	assert.ok((await app.services.artifacts.list(project.id)).length);
	const candidates = await app.services.memory.listCandidates("pending");
	assert.ok(candidates.length);
	assert.equal((await app.services.memory.accept(candidates[0].id)).status, "accepted");
	await app.close();
	app = await createWorkbenchApplication({dataRoot: root});
	assert.equal((await app.services.sessions.get(session.id)).runtimeSessionId, session.runtimeSessionId);
	assert.ok((await app.services.sessions.readTranscript(session.id)).length);
	assert.ok((await app.services.tasks.list({projectId: project.id})).length);
	assert.ok((await app.services.artifacts.list(project.id)).length);
	assert.match(await readFile(join(project.workspacePath, "MEMORY.md"), "utf8"), /classification/iu);
	const resumed = await run(`继续这个项目昨天的工作。这次仅调用 ${normalized}，text="resumed"，然后说明上一轮创建了什么。`);
	assert.ok(resumed.some((event) => event.type === "tool.completed" && event.data.toolName === normalized && !event.data.isError));
	console.log(JSON.stringify({provider: model.provider, model: model.modelId, streaming: true, mcp: true, file: true, artifact: true, task: true, memoryAccepted: true, sameSessionAfterRestart: true}));
} finally {
	await app?.close();
	await rm(root, {recursive: true, force: true});
}
