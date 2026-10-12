import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { createAssistantFixture } from "./assistant-fixture.ts";

test("file preview is scoped to the selected session project and survives restart", async () => {
	const fixture = await createAssistantFixture();
	try {
		const firstRoot = join(fixture.root, "first project");
		const secondRoot = join(fixture.root, "second project");
		await Promise.all([mkdir(firstRoot), mkdir(secondRoot)]);
		await writeFile(join(firstRoot, "notes.md"), "# First project only");
		await writeFile(join(secondRoot, "notes.md"), "# Second project only");
		const firstProject = await fixture.application.services.projects.create({
			name: "First Preview",
			sourcePath: firstRoot,
		});
		const secondProject = await fixture.application.services.projects.create({
			name: "Second Preview",
			sourcePath: secondRoot,
		});
		const first = await fixture.application.createSession({ projectId: firstProject.id });
		const second = await fixture.application.createSession({ projectId: secondProject.id });
		const read = async (sessionId: string, path: string) =>
			fixture.request(`/sessions/${sessionId}/file-preview?path=${encodeURIComponent(path)}`);
		const firstFile = await read(first.id, "notes.md");
		expect(firstFile.status).toBe(200);
		expect(((await firstFile.json()) as { content: string }).content).toBe("# First project only");
		const secondFile = await read(second.id, "notes.md");
		expect(((await secondFile.json()) as { content: string }).content).toBe("# Second project only");
		expect((await read(first.id, join(secondRoot, "notes.md"))).status).not.toBe(200);
		expect((await read(first.id, "../second project/notes.md")).status).not.toBe(200);
		await fixture.restart();
		const restored = await read(first.id, join(firstRoot, "notes.md"));
		expect(restored.status).toBe(200);
		expect(((await restored.json()) as { content: string }).content).toBe("# First project only");
	} finally {
		await fixture.close();
	}
});

test("native picker API returns cancellation and rejects invalid or unauthenticated directory selections", async () => {
	let selected: string | undefined;
	const fixture = await createAssistantFixture(undefined, { pickDirectory: async () => selected });
	try {
		const route = "/system/pick-project-directory";
		const denied = await fetch(`${fixture.address.origin}/api/v1${route}`, { method: "POST" });
		expect(denied.status).toBe(403);
		const cancelled = await fixture.request(route, { method: "POST" });
		expect(cancelled.status).toBe(200);
		expect(await cancelled.json()).toEqual({ path: null });
		selected = join(fixture.root, "does not exist");
		expect((await fixture.request(route, { method: "POST" })).status).toBe(400);
		selected = join(fixture.root, "chosen project");
		await mkdir(selected);
		const accepted = await fixture.request(route, { method: "POST" });
		expect(accepted.status).toBe(200);
		expect(((await accepted.json()) as { path: string }).path).toBe(selected);
	} finally {
		await fixture.close();
	}
});
