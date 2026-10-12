import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { createAssistantFixture } from "./assistant-fixture.ts";

test("the Skill file picker imports the chosen SKILL.md together with its supporting files", async () => {
	let selected: string | undefined;
	const fixture = await createAssistantFixture(undefined, { pickSkillFile: async () => selected });
	try {
		const directory = join(fixture.root, "中文技能");
		await mkdir(join(directory, "scripts"), { recursive: true });
		selected = join(directory, "SKILL.md");
		await writeFile(
			selected,
			"---\nname: picker-skill\ndescription: A selected local skill\n---\nUse scripts/probe.mjs",
		);
		await writeFile(join(directory, "scripts", "probe.mjs"), "console.log(42)");
		const response = await fixture.request("/system/pick-skill-file", { method: "POST" });
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ path: selected, directory });
		const preview = await fixture.application.services.skillImports.preview({
			source: "local",
			location: directory,
			scope: "global",
		});
		expect(preview.candidates[0].files).toContain("scripts/probe.mjs");
		selected = join(directory, "scripts", "probe.mjs");
		expect((await fixture.request("/system/pick-skill-file", { method: "POST" })).status).toBe(400);
		selected = undefined;
		expect(await (await fixture.request("/system/pick-skill-file", { method: "POST" })).json()).toEqual({
			path: null,
			directory: null,
		});
	} finally {
		await fixture.close();
	}
});
