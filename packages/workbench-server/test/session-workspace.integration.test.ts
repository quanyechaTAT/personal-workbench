import { access, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { createAssistantFixture } from "./assistant-fixture.ts";

test("every session owns a directory; deletion migrates, retains or deletes it without touching project sources", async () => {
	const fixture = await createAssistantFixture();
	try {
		const project = await fixture.application.createProject({ name: "工作区归属" });
		const sessions = await Promise.all([
			fixture.application.createSession({ projectId: project.id }),
			fixture.application.createSession({ projectId: project.id }),
			fixture.application.createSession({}),
		]);
		const workspaces = await Promise.all(
			sessions.map((session) => fixture.application.services.sessionWorkspaces.describe(session.id)),
		);
		expect(new Set(workspaces.map((item) => item.path)).size).toBe(3);
		for (const [index, item] of workspaces.entries()) {
			expect(JSON.parse(await readFile(join(item.path, ".workbench-session.json"), "utf8"))).toMatchObject({
				sessionId: sessions[index].id,
			});
			await writeFile(join(item.path, "output.txt"), sessions[index].id);
			await writeFile(join(item.path, ".env"), "FIXTURE_ONLY=example");
		}
		expect(sessions[0].cwd).toBe(project.workspacePath);
		await writeFile(join(project.workspacePath, "source.txt"), "项目源文件");
		await fixture.application.services.settings.set(`session.workspaceDisposition.${sessions[1].id}`, "keep");
		await fixture.application.services.settings.set(`session.workspaceDisposition.${sessions[2].id}`, "delete");
		for (const session of sessions)
			expect((await fixture.request(`/sessions/${session.id}`, { method: "DELETE" })).status).toBe(200);
		expect(await readFile(join(workspaces[0].migrationPath, "output.txt"), "utf8")).toBe(sessions[0].id);
		await expect(access(workspaces[0].path)).rejects.toMatchObject({ code: "ENOENT" });
		expect(await readFile(join(workspaces[1].path, "output.txt"), "utf8")).toBe(sessions[1].id);
		await expect(access(workspaces[2].path)).rejects.toMatchObject({ code: "ENOENT" });
		expect(await readFile(join(project.workspacePath, "source.txt"), "utf8")).toBe("项目源文件");
		await fixture.restart();
		expect(await fixture.application.services.sessions.list()).toEqual([]);
		expect(await readFile(join(workspaces[0].migrationPath, "output.txt"), "utf8")).toBe(sessions[0].id);
	} finally {
		await fixture.close();
	}
});

test("workspace conflicts and directory junctions reject deletion before touching conversation history", async () => {
	const fixture = await createAssistantFixture();
	try {
		const occupied = await fixture.application.createSession({});
		const target = await fixture.application.services.sessionWorkspaces.describe(occupied.id);
		await mkdir(target.migrationPath, { recursive: true });
		await writeFile(join(target.migrationPath, "existing.txt"), "原归档");
		expect((await fixture.request(`/sessions/${occupied.id}`, { method: "DELETE" })).status).toBe(409);
		await access(occupied.runtimeRef);
		expect((await fixture.application.services.sessions.get(occupied.id)).deletionRequestedAt).toBeUndefined();
		expect(await readFile(join(target.migrationPath, "existing.txt"), "utf8")).toBe("原归档");
		const linked = await fixture.application.createSession({});
		const workspace = await fixture.application.services.sessionWorkspaces.describe(linked.id);
		const outside = join(fixture.root, "outside-owned-tree");
		await mkdir(outside);
		await writeFile(join(outside, "keep.txt"), "不能删除");
		await symlink(outside, join(workspace.path, "linked"), process.platform === "win32" ? "junction" : "dir");
		await fixture.application.services.settings.set(`session.workspaceDisposition.${linked.id}`, "delete");
		expect((await fixture.request(`/sessions/${linked.id}`, { method: "DELETE" })).status).toBe(403);
		await access(linked.runtimeRef);
		expect(await readFile(join(outside, "keep.txt"), "utf8")).toBe("不能删除");
		expect((await fixture.application.services.sessions.get(linked.id)).deletionRequestedAt).toBeUndefined();
	} finally {
		await fixture.close();
	}
});
