import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { expect, test } from "vitest";
import { createAssistantFixture } from "./assistant-fixture.ts";

test("chats without projects have independent folders and retain them after restart", async () => {
	const fixture = await createAssistantFixture();
	try {
		const first = await fixture.application.createSession({ profileSlug: "standard" });
		const second = await fixture.application.createSession({ profileSlug: "standard" });
		expect(await fixture.application.services.projects.list()).toEqual([]);
		expect(first.projectId).toBeUndefined();
		expect(first.title).toBe("新对话");
		expect(first.cwd).not.toBe(fixture.application.paths.workspace);
		expect(first.cwd).not.toBe(second.cwd);
		await writeFile(join(first.cwd, "private.txt"), "first chat");
		await expect(readFile(join(second.cwd, "private.txt"))).rejects.toMatchObject({ code: "ENOENT" });
		await fixture.restart();
		expect((await fixture.application.services.sessions.get(first.id)).cwd).toBe(first.cwd);
		expect(await readFile(join(first.cwd, "private.txt"), "utf8")).toBe("first chat");
	} finally {
		await fixture.close();
	}
});

test("unassigned chat context includes unassigned tasks but excludes project tasks", async () => {
	const fixture = await createAssistantFixture();
	try {
		const project = await fixture.application.services.projects.create({ name: "隔离项目" });
		await fixture.application.services.tasks.create({ title: "project-private-task", projectId: project.id });
		await fixture.application.services.tasks.create({ title: "unassigned-task" });
		const session = await fixture.application.createSession({ profileSlug: "standard" });
		const context = await fixture.application.contextForSession(session.id);
		expect(context.runtime.appendSystemPrompt?.join("\n")).toContain("unassigned-task");
		expect(context.runtime.appendSystemPrompt?.join("\n")).not.toContain("project-private-task");
	} finally {
		await fixture.close();
	}
});

test("unassigned chats register artifacts relative to their own folder", async () => {
	const fixture = await createAssistantFixture();
	try {
		const session = await fixture.application.createSession({ profileSlug: "standard" });
		await writeFile(join(session.cwd, "report.txt"), "owned by this chat");
		fixture.faux.setResponses([
			fauxAssistantMessage(
				fauxToolCall("artifact_register", { type: "report", name: "report", workspaceRelativePath: "report.txt" }),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("已登记"),
		]);
		const context = await fixture.application.contextForSession(session.id);
		const run = fixture.application.events.start(session.id, { text: "登记报告", context: context.runtime });
		for await (const _entry of fixture.application.events.subscribe(run.runId)) {
			/* drain */
		}
		expect((await fixture.application.services.artifacts.list())[0]?.filePath).toBe(join(session.cwd, "report.txt"));
	} finally {
		await fixture.close();
	}
});
