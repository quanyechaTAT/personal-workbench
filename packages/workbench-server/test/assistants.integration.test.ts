import { mkdir, readFile, rename, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import type { AgentProfile, AssistantDraft, SkillImport, WorkbenchSkill } from "@earendil-works/workbench-core";
import { afterEach, expect, test } from "vitest";
import { parseGitTree } from "../src/skill-sources/git-source.ts";
import { createAssistantFixture } from "./assistant-fixture.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

test("assistant revisions, selected MCP tools, approvals, errors, offline history and restart use real Pi", async () => {
	const fixture = await createAssistantFixture();
	cleanups.push(() => fixture.close());
	const app = fixture.application;
	const connection = await app.services.connections.create({
		name: "Protocol fixture",
		transport: "stdio",
		authKind: "none",
		stdio: {
			command: process.execPath,
			args: [fileURLToPath(new URL("../../workbench-mcp/test/fixtures/stdio-server.mjs", import.meta.url))],
			environmentKeys: [],
		},
	});
	const catalog = await app.services.connections.test(connection.id);
	const echo = catalog.tools.find((tool) => tool.name === "echo")!;
	const profile = await app.services.profiles.create({
		name: "视觉研究助手",
		systemPrompt: "Use the CV research workflow.",
		tools: [],
		skillIds: [],
		mcpBindings: [
			{
				connectionId: connection.id,
				toolName: "echo",
				approvedDefinitionHash: echo.definitionHash,
				approval: "ask",
			},
		],
	});
	await app.services.profiles.setDefault(profile.id);
	await expect(app.services.profiles.archive(profile.id, profile.version)).rejects.toThrow("default");
	const session = await app.createSession({});
	expect(session.agentProfileId).toBe(profile.id);
	const resolved = await app.services.capabilities.resolveForSession(profile);
	expect(resolved.toolBindings).toHaveLength(1);
	fixture.faux.setResponses([
		fauxAssistantMessage(
			fauxToolCall(resolved.toolBindings[0].descriptor.name, { text: "CV evidence" }, { id: "approved-echo" }),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("Evidence received."),
	]);
	const started = app.events.start(session.id, {
		text: "Use echo",
		context: (await app.contextForSession(session.id)).runtime,
	});
	await expect.poll(async () => (await app.repositories.approvals.listPending()).length).toBe(1);
	const approval = (await app.repositories.approvals.listPending())[0];
	await app.services.permissions.resolve(approval.id, "approved");
	const events = [];
	for await (const event of app.events.subscribe(started.runId)) events.push(event.event);
	expect(events.some((event) => event.type === "tool.completed" && !event.data.isError)).toBe(true);
	expect(events.some((event) => event.type === "run.completed")).toBe(true);
	const updated = await app.services.profiles.update(
		profile.id,
		{ ...profile, systemPrompt: "Updated CV instructions", mcpBindings: [], tools: ["task_list"] },
		profile.version,
	);
	expect(updated.version).toBe(2);
	await expect(app.services.profiles.update(profile.id, profile, 1)).rejects.toMatchObject({ code: "conflict" });
	expect((await app.services.profiles.getRevision(profile.id, 1)).config.systemPrompt).toBe(profile.systemPrompt);
	fixture.faux.setResponses([fauxAssistantMessage("Updated configuration applied.")]);
	const next = app.events.start(session.id, {
		text: "Continue",
		context: (await app.contextForSession(session.id)).runtime,
	});
	for await (const _event of app.events.subscribe(next.runId)) {
		/* consume the persisted run */
	}
	expect((await app.services.sessions.get(session.id)).appliedProfileVersion).toBe(2);
	expect((await app.services.sessions.get(session.id)).runtimeSessionId).toBe(session.runtimeSessionId);
	await app.services.connections.setEnabled(connection.id, false, connection.version);
	await fixture.restart();
	expect((await fixture.application.services.sessions.readTranscript(session.id)).length).toBeGreaterThan(3);
	expect((await fixture.application.services.profiles.get(profile.id)).version).toBe(2);
	fixture.faux.setResponses([fauxAssistantMessage("Resumed after restart.")]);
	const resumed = fixture.application.events.start(session.id, {
		text: "继续昨天的工作",
		context: (await fixture.application.contextForSession(session.id)).runtime,
	});
	const final = [];
	for await (const entry of fixture.application.events.subscribe(resumed.runId)) final.push(entry.event.type);
	expect(final).toContain("run.completed");
}, 45_000);

test("imports complete Skills, previews updates, rejects local edits and recovers an interrupted directory swap", async () => {
	const fixture = await createAssistantFixture();
	cleanups.push(() => fixture.close());
	const source = join(fixture.root, "source", "cv-notes");
	await mkdir(join(source, "references"), { recursive: true });
	await writeFile(
		join(source, "SKILL.md"),
		"---\nname: cv-notes\ndescription: Record CV experiments\n---\nRead references/template.md.\n",
	);
	await writeFile(join(source, "references", "template.md"), "Version one");
	const previewResponse = await fixture.request("/skills/imports", {
		method: "POST",
		body: JSON.stringify({ source: "local", location: source, scope: "global" }),
	});
	expect(previewResponse.status).toBe(201);
	const preview = (await previewResponse.json()) as SkillImport;
	expect(preview.candidates[0].files).toContain("references/template.md");
	const importedResponse = await fixture.request(`/skills/imports/${preview.id}/commit`, {
		method: "POST",
		body: JSON.stringify({ slugs: ["cv-notes"] }),
	});
	expect(importedResponse.status).toBe(200);
	const imported = (await importedResponse.json()) as { skills: WorkbenchSkill[] };
	const skill = imported.skills[0];
	await writeFile(join(source, "references", "template.md"), "Version two");
	const update = await fixture.application.services.skillImports.previewUpdate(skill.id);
	expect(update.candidates[0].update?.changes).toEqual([{ path: "references/template.md", kind: "changed" }]);
	expect(
		await fixture.application.services.skillImports.readPreviewFile(update.id, skill.slug, "references/template.md"),
	).toEqual({ before: "Version one", after: "Version two" });
	await fixture.application.services.skillImports.commitImport(update.id, [skill.slug]);
	expect(await readFile(join(dirname(skill.path), "references", "template.md"), "utf8")).toBe("Version two");
	await writeFile(join(dirname(skill.path), "references", "template.md"), "Local edit");
	await expect(fixture.application.services.skillImports.previewUpdate(skill.id)).rejects.toMatchObject({
		code: "conflict",
	});
	await writeFile(join(dirname(skill.path), "references", "template.md"), "Version two");
	const interrupted = await fixture.application.services.skillImports.previewUpdate(skill.id);
	await writeFile(`${interrupted.stagingPath}.journal.json`, JSON.stringify([skill.slug]));
	await rename(dirname(skill.path), `${dirname(skill.path)}.backup-${interrupted.id}`);
	await fixture.restart();
	expect(await readFile(join(dirname(skill.path), "references", "template.md"), "utf8")).toBe("Version two");
	expect((await fixture.application.services.skillImports.get(interrupted.id)).status).toBe("failed");
	expect((await fixture.application.services.skills.get(skill.id)).id).toBe(skill.id);
}, 30_000);

test("draft generation uses a real isolated Pi session and API optimistic locking", async () => {
	const fixture = await createAssistantFixture();
	cleanups.push(() => fixture.close());
	fixture.faux.setResponses([
		fauxAssistantMessage(
			JSON.stringify({
				name: "CV Reader",
				description: "Evidence-based review",
				systemPrompt: "Read CV papers carefully.",
				tools: ["read"],
				skillIds: [],
				mcpBindings: [],
			}),
		),
	]);
	const response = await fixture.request("/assistant-drafts", {
		method: "POST",
		body: JSON.stringify({ requirement: "研究计算机视觉" }),
	});
	expect(response.status).toBe(202);
	const { draft } = (await response.json()) as { draft: AssistantDraft };
	await expect
		.poll(async () => (await fixture.application.services.assistantDrafts.get(draft.id)).status)
		.toBe("ready");
	const created = await fixture.request(`/assistant-drafts/${draft.id}/create-profile`, { method: "POST" });
	expect(created.status).toBe(201);
	const saved = (await created.json()) as AssistantDraft;
	expect(saved.createdProfileId).toBeTruthy();
	const profile = await fixture.application.services.profiles.get(saved.createdProfileId!);
	expect(profile.name).toBe("CV Reader");
	const conflict = await fixture.request(`/profiles/${profile.id}`, {
		method: "PUT",
		body: JSON.stringify({
			name: "Changed",
			systemPrompt: "Changed",
			tools: [],
			skillIds: [],
			mcpBindings: [],
			expectedVersion: 99,
		}),
	});
	expect(conflict.status).toBe(409);
	const listed = (await (await fixture.request("/profiles")).json()) as AgentProfile[];
	expect(listed.some((value) => value.id === profile.id)).toBe(true);
}, 30_000);

test("Git object manifest refuses links, traversal, Windows names and case collisions before copying", () => {
	const oid = "a".repeat(40);
	expect(() => parseGitTree(`120000 blob ${oid} 6\tlink\0`)).toThrow("links");
	expect(() => parseGitTree(`100644 blob ${oid} 1\t../escape\0`)).toThrow();
	expect(() => parseGitTree(`100644 blob ${oid} 1\tCON.txt\0`)).toThrow();
	expect(() => parseGitTree(`100644 blob ${oid} 1\tRef/a.md\x00100644 blob ${oid} 1\tref/b.md\0`)).toThrow();
});

test("connection API stores secrets privately, scopes replacements, and rejects stale updates", async () => {
	const fixture = await createAssistantFixture();
	cleanups.push(() => fixture.close());
	const input = {
		name: "Private MCP",
		transport: "streamable-http",
		authKind: "headers",
		remote: { url: "https://example.com/mcp", headerNames: [] },
		secret: { bearerToken: "test-secret-never-returned" },
	};
	const response = await fixture.request("/mcp/connections", { method: "POST", body: JSON.stringify(input) });
	expect(response.status, JSON.stringify(await fixture.application.logger.readRecent())).toBe(201);
	const dto = (await response.json()) as { id: string; version: number };
	expect(JSON.stringify(dto)).not.toContain("test-secret");
	expect(JSON.stringify(dto)).not.toContain("secretRef");
	const catalog = await fixture.request("/capabilities");
	expect(catalog.status).toBe(200);
	expect(JSON.stringify(await catalog.json())).not.toContain("secretRef");
	const original = await fixture.application.services.connections.get(dto.id);
	expect((await fixture.application.secrets.getSecret(original.secretRef!))?.bearerToken).toBe(
		input.secret.bearerToken,
	);
	const changed = await fixture.request(`/mcp/connections/${dto.id}`, {
		method: "PUT",
		body: JSON.stringify({
			...input,
			secret: undefined,
			authKind: "oauth",
			remote: { url: "https://new.example.com/mcp", headerNames: [] },
			expectedVersion: dto.version,
		}),
	});
	expect(changed.status).toBe(200);
	const updated = await fixture.application.services.connections.get(dto.id);
	expect(updated.secretRef).not.toBe(original.secretRef);
	expect(await fixture.application.secrets.getSecret(original.secretRef!)).toBeUndefined();
	expect((await fixture.application.secrets.getSecret(updated.secretRef!))?.bearerToken).toBeUndefined();
	await fixture.application.disconnectAuthorization(dto.id);
	expect((await fixture.application.services.connections.get(dto.id)).version).toBe(updated.version + 1);
	const stale = await fixture.request(`/mcp/connections/${dto.id}`, {
		method: "PUT",
		body: JSON.stringify({ ...input, expectedVersion: 1 }),
	});
	expect(stale.status).toBe(409);
}, 30_000);

test("MCP error results stay errors in Pi and stopping during approval cancels the pending operation", async () => {
	const fixture = await createAssistantFixture();
	cleanups.push(() => fixture.close());
	const app = fixture.application;
	const connection = await app.services.connections.create({
		name: "Cancelable MCP",
		transport: "stdio",
		authKind: "none",
		stdio: {
			command: process.execPath,
			args: [fileURLToPath(new URL("../../workbench-mcp/test/fixtures/stdio-server.mjs", import.meta.url))],
			environmentKeys: [],
		},
	});
	const catalog = await app.services.connections.test(connection.id);
	const fail = catalog.tools.find((tool) => tool.name === "fail")!;
	const profile = await app.services.profiles.create({
		name: "Tool errors",
		systemPrompt: "Use only your selected tools.",
		tools: [],
		mcpBindings: [
			{
				connectionId: connection.id,
				toolName: fail.name,
				approvedDefinitionHash: fail.definitionHash,
				approval: "allow",
			},
		],
	});
	const session = await app.createSession({ profileId: profile.id });
	await app.services.permissions.setMode(session.id, "auto");
	const toolName = (await app.services.capabilities.resolveForSession(profile)).toolBindings[0].descriptor.name;
	fixture.faux.setResponses([
		fauxAssistantMessage(fauxToolCall(toolName, {}, { id: "failed-call" }), { stopReason: "toolUse" }),
		fauxAssistantMessage("Reported the failure."),
	]);
	const run = app.events.start(session.id, {
		text: "Run the test tool",
		context: (await app.contextForSession(session.id)).runtime,
	});
	const events = [];
	for await (const entry of app.events.subscribe(run.runId)) events.push(entry.event);
	expect(events.some((event) => event.type === "tool.completed" && event.data.isError)).toBe(true);
	expect(
		(await app.services.sessions.readTranscript(session.id)).some(
			(message) => message.role === "tool" && message.isError,
		),
	).toBe(true);
	await app.services.profiles.update(
		profile.id,
		{ ...profile, mcpBindings: profile.mcpBindings.map((binding) => ({ ...binding, approval: "ask" })) },
		profile.version,
	);
	fixture.faux.setResponses([
		fauxAssistantMessage(fauxToolCall(toolName, {}, { id: "approval-call" }), { stopReason: "toolUse" }),
	]);
	const waiting = app.events.start(session.id, {
		text: "Wait for approval",
		context: (await app.contextForSession(session.id)).runtime,
	});
	await expect.poll(async () => (await app.repositories.approvals.listPending()).length).toBe(1);
	const response = await fixture.request(`/sessions/${session.id}/abort`, { method: "POST" });
	expect(response.status).toBe(202);
	const final = [];
	for await (const entry of app.events.subscribe(waiting.runId)) final.push(entry.event.type);
	expect(final).toContain("run.aborted");
	expect(await app.repositories.approvals.listPending()).toEqual([]);
}, 30_000);

test("Skill editor rejects a workspace junction replaced with an external directory", async () => {
	const fixture = await createAssistantFixture();
	cleanups.push(() => fixture.close());
	const app = fixture.application;
	const skill = await app.services.skills.create({
		slug: "junction-test",
		name: "Junction",
		description: "Test containment",
		scope: "global",
	});
	const outside = join(fixture.root, "external-skill");
	await rename(dirname(skill.path), outside);
	await symlink(outside, dirname(skill.path), process.platform === "win32" ? "junction" : "dir");
	await expect(app.services.skills.readContent(skill.id)).rejects.toMatchObject({ code: "path_denied" });
}, 30_000);
