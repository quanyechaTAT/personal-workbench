import { mkdir, readdir, readFile, rename, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { PathPolicy, semanticBlocks, WorkspaceManager } from "@earendil-works/workbench-core";
import { expect, test } from "vitest";
import { createWorkbenchApplication } from "../src/application.ts";
import { createAssistantFixture } from "./assistant-fixture.ts";

const memoryHash = (text: string) => createHash("sha256").update(text).digest("hex");

test("USER.md belongs to the data root; Memory Gateway edits and indexes it without exposing internal files", async () => {
	const fixture = await createAssistantFixture();
	try {
		const { paths, services } = fixture.application;
		expect(paths.userMemory).toBe(join(paths.root, "USER.md"));
		expect(await readdir(paths.workspace)).not.toContain("USER.md");
		const original = await services.memory.read("USER.md");
		expect((await fixture.request("/memory/file?path=USER.md")).status).toBe(200);
		expect((await fixture.request("/files/read?path=USER.md")).status).toBe(404);
		expect(JSON.stringify(await (await fixture.request("/settings")).json())).not.toContain(
			"memory.userDocumentLocation",
		);
		expect(
			(
				await fixture.request("/settings/memory.userDocumentLocation", {
					method: "PUT",
					body: JSON.stringify({ value: "legacy" }),
				})
			).status,
		).toBe(400);
		for (const path of ["../USER.md", "../state/workbench.db", "../config/workbench.json", paths.userMemory]) {
			expect((await fixture.request(`/memory/file?path=${encodeURIComponent(path)}`)).status).toBe(404);
			await expect(new PathPolicy(paths).requireWorkspace(path)).rejects.toBeDefined();
		}
		const content = `${original.content}\n用户偏好：长期使用简短中文，先给结论。\n`;
		expect(
			(
				await fixture.request("/memory/file", {
					method: "PUT",
					body: JSON.stringify({ path: "USER.md", kind: "user", content, expectedHash: original.contentHash }),
				})
			).status,
		).toBe(200);
		expect(await readFile(paths.userMemory, "utf8")).toBe(content);
		expect(
			(
				await fixture.request("/memory/file", {
					method: "PUT",
					body: JSON.stringify({
						path: "USER.md",
						kind: "user",
						content: "stale overwrite",
						expectedHash: original.contentHash,
					}),
				})
			).status,
		).toBe(409);
		expect(
			(
				await fixture.request("/files/write", {
					method: "PUT",
					body: JSON.stringify({
						path: "USER.md",
						content: "workspace duplicate",
						expectedHash: memoryHash(content),
					}),
				})
			).status,
		).toBe(403);
		expect(await stat(join(paths.workspace, "USER.md")).catch(() => undefined)).toBeUndefined();
		expect((await services.memory.search({}, "长期使用简短中文")).some((hit) => hit.kind === "user")).toBe(true);
		const project = await fixture.application.createProject({ name: "工作台偏好共享 中文 空格" });
		const session = await fixture.application.createSession({ projectId: project.id });
		fixture.faux.setResponses([
			(context) => {
				expect(JSON.stringify(context)).toContain("长期使用简短中文，先给结论");
				return fauxAssistantMessage("按约定继续。");
			},
		]);
		const context = await fixture.application.contextForSession(session.id, "继续");
		for await (const _event of fixture.application.events.subscribe(
			fixture.application.events.start(session.id, {
				text: "继续",
				context: context.runtime,
				turnContext: context.turn,
			}).runId,
		)) {
			/* real Pi and model context */
		}
		await fixture.restart();
		expect(await readFile(paths.userMemory, "utf8")).toBe(content);
		expect((await fixture.application.services.sessions.get(session.id)).runtimeSessionId).toBe(
			session.runtimeSessionId,
		);
	} finally {
		await fixture.close();
	}
});

test.each(["before-file", "after-file", "after-index"] as const)(
	"v027 USER migration recovers %s write boundary and preserves IDs, evidence, versions and rollback",
	async (boundary) => {
		const fixture = await createAssistantFixture();
		try {
			const { paths, services, repositories } = fixture.application;
			const evidence = {
				kind: "file" as const,
				id: "user-preference-source",
				path: "inbox/用户原话.txt",
				excerpt: "用户偏好所有项目先给结论。",
				confirmation: "user_confirmed" as const,
				availability: "present" as const,
			};
			await writeFile(join(paths.inbox, "用户原话.txt"), evidence.excerpt);
			const first = await services.memory.propose(
				{},
				{ kind: "user", proposedText: "用户偏好所有项目先给结论。", reason: "用户确认", evidence: [evidence] },
			);
			await services.memory.accept(first.id);
			await services.semantic.change(
				{},
				{
					kind: "user",
					proposedText: "用户偏好所有项目先给结论，再给必要步骤。",
					reason: "用户长期更正",
					semanticChange: { operation: "update", targetId: first.id, expectedVersion: 1 },
				},
			);
			const before = await readFile(paths.userMemory, "utf8");
			const candidate = await services.memory.propose(
				{},
				{ kind: "user", proposedText: "用户偏好后续报告使用编号列表。", reason: "另一个长期偏好" },
			);
			await rename(paths.userMemory, join(paths.workspace, "USER.md"));
			const database = new DatabaseSync(paths.database);
			database.prepare("DELETE FROM settings WHERE key='memory.userDocumentLocation'").run();
			database.close();
			await repositories.semantic.saveWriteIntent({
				id: `legacy-user-${boundary}`,
				kind: "user",
				relativePath: "USER.md",
				candidateId: candidate.id,
				before,
				after: candidate.preview,
				beforeHash: memoryHash(before),
				afterHash: memoryHash(candidate.preview),
				status: "prepared",
				createdAt: new Date().toISOString(),
			});
			if (boundary !== "before-file") await writeFile(join(paths.workspace, "USER.md"), candidate.preview);
			if (boundary === "after-index")
				await repositories.memory.updateCandidate({ ...candidate, appliedHash: memoryHash(candidate.preview) });
			await fixture.restart();
			expect(await readdir(paths.workspace)).not.toContain("USER.md");
			expect(await readFile(paths.userMemory, "utf8")).toBe(candidate.preview);
			expect((await fixture.application.services.memory.getCandidate(candidate.id)).status).toBe("accepted");
			const current = (await fixture.application.services.semantic.list({})).find((fact) => fact.id === first.id);
			expect(current).toMatchObject({
				kind: "user",
				version: 2,
				confirmation: "user_confirmed",
				conflict: "none",
				relativePath: "USER.md",
				evidence: [evidence],
			});
			expect(
				(await fixture.application.services.semantic.history(first.id, {})).map((fact) => fact.version),
			).toEqual([2, 1]);
			expect(await fixture.application.repositories.semantic.listWriteIntents()).toEqual([]);
			const backup = join(
				paths.memory,
				`history/user-root-v2/workspace/USER.md.${memoryHash(candidate.preview)}.md`,
			);
			expect(await readFile(backup, "utf8")).toBe(candidate.preview);
			await fixture.restart();
			expect(await readFile(paths.userMemory, "utf8")).toBe(candidate.preview);
			await fixture.application.services.semantic.change(
				{},
				{
					kind: "user",
					proposedText: "回滚偏好",
					reason: "用户选择历史版本",
					semanticChange: { operation: "rollback", targetId: first.id, expectedVersion: 2, rollbackVersion: 1 },
				},
			);
			expect((await fixture.application.services.semantic.list({})).find((fact) => fact.id === first.id)?.text).toBe(
				"用户偏好所有项目先给结论。",
			);
			expect(await readdir(paths.workspace)).not.toContain("USER.md");
		} finally {
			await fixture.close();
		}
	},
);

test("two USER files merge unique prose and stable anchors once; interrupted publication retires the old file on restart", async () => {
	const fixture = await createAssistantFixture();
	try {
		const { paths, services } = fixture.application;
		const candidate = await services.memory.propose(
			{},
			{ kind: "user", proposedText: "用户偏好保留中文术语。", reason: "确认" },
		);
		await services.memory.accept(candidate.id);
		const common = await readFile(paths.userMemory, "utf8");
		const rootContent = `${common}\n根目录独有偏好：说明应简短。\n`;
		const legacy = `${common}\n工作区独有偏好：列表使用编号。\n`;
		await writeFile(paths.userMemory, rootContent);
		await writeFile(join(paths.workspace, "USER.md"), legacy);
		await fixture.restart();
		const merged = await readFile(paths.userMemory, "utf8");
		expect(merged).toContain("根目录独有偏好");
		expect(merged).toContain("工作区独有偏好");
		expect(semanticBlocks(merged, "user", "USER.md").map((block) => block.record.id)).toEqual([candidate.id]);
		for (const [location, content] of [
			["root", rootContent],
			["workspace", legacy],
		])
			expect(
				await readFile(
					join(paths.memory, `history/user-root-v2/${location}/USER.md.${memoryHash(content)}.md`),
					"utf8",
				),
			).toBe(content);
		await writeFile(join(paths.workspace, "USER.md"), legacy);
		await fixture.restart();
		expect(await readFile(paths.userMemory, "utf8")).toBe(merged);
		expect(await readdir(paths.workspace)).not.toContain("USER.md");
	} finally {
		await fixture.close();
	}
});

test("conflicting anchors and corrupted migration backups preserve both USER originals", async () => {
	const fixture = await createAssistantFixture();
	try {
		const { paths, services } = fixture.application;
		const candidate = await services.memory.propose(
			{},
			{ kind: "user", proposedText: "用户偏好简短回答。", reason: "确认" },
		);
		await services.memory.accept(candidate.id);
		const rootContent = await readFile(paths.userMemory, "utf8");
		const legacy = rootContent.replace("用户偏好简短回答。", "用户偏好详细回答。");
		await writeFile(join(paths.workspace, "USER.md"), legacy);
		const manager = new WorkspaceManager(paths);
		const policy = new PathPolicy(paths);
		await expect(manager.consolidateLegacyMemory(policy, [])).rejects.toMatchObject({ code: "conflict" });
		expect(await readFile(paths.userMemory, "utf8")).toBe(rootContent);
		expect(await readFile(join(paths.workspace, "USER.md"), "utf8")).toBe(legacy);
		await writeFile(
			join(paths.memory, `history/user-root-v2/workspace/USER.md.${memoryHash(legacy)}.md`),
			"corrupted backup",
		);
		await expect(manager.consolidateLegacyMemory(policy, [])).rejects.toMatchObject({ code: "conflict" });
		expect(await readFile(paths.userMemory, "utf8")).toBe(rootContent);
		expect(await readFile(join(paths.workspace, "USER.md"), "utf8")).toBe(legacy);
	} finally {
		await fixture.close();
	}
});

test("root USER access rejects junctions; a second running instance cannot create or migrate the root file", async () => {
	const fixture = await createAssistantFixture();
	try {
		const { paths } = fixture.application;
		await rename(paths.userMemory, join(paths.workspace, "USER.md"));
		await expect(
			createWorkbenchApplication({
				dataRoot: paths.root,
				agentDir: join(fixture.root, "pi-agent"),
				embeddingEnvFile: fixture.embeddingEnvFile,
				pi: { modelRuntime: fixture.modelRuntime, defaultModel: fixture.model },
			}),
		).rejects.toMatchObject({ code: "conflict" });
		expect(await stat(paths.userMemory).catch(() => undefined)).toBeUndefined();
		expect(await stat(join(paths.workspace, "USER.md"))).toBeDefined();
		await rename(join(paths.workspace, "USER.md"), paths.userMemory);
		await unlink(paths.userMemory);
		const outside = join(fixture.root, "outside");
		await mkdir(outside);
		await writeFile(join(outside, "private.txt"), "DO_NOT_READ");
		await symlink(outside, paths.userMemory, process.platform === "win32" ? "junction" : "dir");
		await expect(new PathPolicy(paths).requireMemory("USER.md")).rejects.toMatchObject({ code: "path_denied" });
		expect((await fixture.request("/memory/file?path=USER.md")).status).toBe(403);
	} finally {
		await fixture.close();
	}
});

import { createHash } from "node:crypto";
