import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { createAssistantFixture } from "./assistant-fixture.ts";

const legacyNames = [
	["coding", "Coding"],
	["project-planning", "Project Planning"],
	["research", "Research"],
	["weekly-review", "Weekly Review"],
] as const;

test("startup repairs all four legacy builtin Skill names and retains their IDs and assistant bindings", async () => {
	const fixture = await createAssistantFixture();
	try {
		const before = await fixture.application.services.skills.list();
		const profile = await fixture.application.services.profiles.getBySlug("standard");
		for (const [slug, name] of legacyNames) {
			const path = join(fixture.application.paths.skills, slug, "SKILL.md");
			const content = await readFile(path, "utf8");
			await writeFile(path, content.replace(`name: ${slug}`, `name: ${name}`));
		}
		await fixture.restart();
		const repaired = await fixture.application.services.skills.list();
		for (const [slug] of legacyNames) {
			const skill = repaired.find((item) => item.slug === slug)!;
			expect(skill.name).toBe(slug);
			expect(skill.diagnostics).toEqual([]);
			expect(skill.id).toBe(before.find((item) => item.slug === slug)?.id);
		}
		expect((await fixture.application.services.profiles.get(profile.id)).skillIds).toEqual(profile.skillIds);
	} finally {
		await fixture.close();
	}
});

test("repairing builtin metadata preserves user instructions and disabled state across repeated restarts", async () => {
	const fixture = await createAssistantFixture();
	try {
		const skill = (await fixture.application.services.skills.list()).find((item) => item.slug === "research")!;
		await fixture.application.services.skills.setEnabled(skill.id, false);
		const path = skill.path;
		const content =
			"---\r\nname: Research\r\ndescription: 我的研究流程\r\n---\r\n\r\n# 自定义研究\r\n先检索项目知识库，只引用核实过的资料。\r\n";
		await writeFile(path, content);
		await fixture.restart();
		const repaired = await readFile(path, "utf8");
		expect(repaired).toBe(content.replace("name: Research", "name: research"));
		expect(await fixture.application.services.skills.get(skill.id)).toMatchObject({
			enabled: false,
			diagnostics: [],
		});
		await fixture.restart();
		expect(await readFile(path, "utf8")).toBe(repaired);
	} finally {
		await fixture.close();
	}
});

test("an unedited legacy template upgrades to the current research workflow without changing its ID", async () => {
	const fixture = await createAssistantFixture();
	try {
		const skill = (await fixture.application.services.skills.list()).find((item) => item.slug === "research")!;
		await writeFile(
			skill.path,
			"---\nname: 'Research'\ndescription: Research questions with traceable sources and explicit evidence boundaries.\n---\n\n# Research\n\nGather sources, distinguish quotations from inference, and record useful outputs as artifacts.\n",
		);
		await fixture.restart();
		const upgraded = await fixture.application.services.skills.get(skill.id);
		expect(upgraded).toMatchObject({ name: "research", diagnostics: [] });
		expect(upgraded.description).toContain("研究问题");
		const content = await readFile(skill.path, "utf8");
		expect(content).toContain("knowledge_search");
		expect(content).toContain("PTC 助手通过 run_code");
		await fixture.restart();
		expect(await readFile(skill.path, "utf8")).toBe(content);
	} finally {
		await fixture.close();
	}
});
