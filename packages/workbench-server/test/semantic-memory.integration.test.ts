import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { expect, test } from "vitest";
import { createAssistantFixture } from "./assistant-fixture.ts";

test("stable facts supersede Python 3.10 with 3.12, deduplicate, invalidate and roll back without recalling history", async () => {
	const fixture = await createAssistantFixture();
	try {
		const project = await fixture.application.createProject({ name: "Python 事实更新" });
		const memory = fixture.application.services.memory;
		const semantic = fixture.application.services.semantic;
		const create = await memory.propose(
			{ project },
			{ kind: "project", proposedText: "项目使用 Python 3.10。", reason: "用户明确确认" },
		);
		expect((await memory.accept(create.id)).status).toBe("accepted");
		const upgrade = await memory.propose(
			{ project },
			{ kind: "project", proposedText: "项目使用 Python 3.12。", reason: "用户明确迁移" },
		);
		expect(upgrade.semanticChange).toMatchObject({ operation: "supersede", targetId: create.id, expectedVersion: 1 });
		await memory.accept(upgrade.id);
		const hits = await memory.search({ project }, "Python");
		expect(hits.map((hit) => hit.snippet).join("\n")).toContain("Python 3.12");
		expect(hits.map((hit) => hit.snippet).join("\n")).not.toContain("Python 3.10");
		expect((await semantic.history(create.id, { project })).map((record) => record.version)).toEqual([2, 1]);
		const duplicate = await memory.propose(
			{ project },
			{ kind: "project", proposedText: "项目使用 Python 3.12。", reason: "再次确认" },
		);
		expect(duplicate.semanticChange?.operation).toBe("merge");
		await memory.accept(duplicate.id);
		expect((await semantic.list({ project })).map((record) => record.id)).toEqual([upgrade.id]);
		await expect(
			memory.propose(
				{ project },
				{
					kind: "project",
					proposedText: "使用 Python 3.13",
					reason: "旧版本请求",
					semanticChange: { operation: "update", targetId: upgrade.id, expectedVersion: 1 },
				},
			),
		).rejects.toMatchObject({ code: "conflict" });
		await semantic.change(
			{ project },
			{
				kind: "project",
				proposedText: "恢复旧版本",
				reason: "用户回滚",
				semanticChange: { operation: "rollback", targetId: create.id, expectedVersion: 2, rollbackVersion: 1 },
			},
		);
		expect((await memory.search({ project }, "Python")).map((hit) => hit.snippet).join("\n")).toContain(
			"Python 3.10",
		);
		expect((await memory.search({ project }, "Python")).map((hit) => hit.snippet).join("\n")).not.toContain(
			"Python 3.12",
		);
		await semantic.change(
			{ project },
			{
				kind: "project",
				proposedText: "失效",
				reason: "用户停止维护",
				semanticChange: { operation: "invalidate", targetId: create.id, expectedVersion: 3 },
			},
		);
		expect(await semantic.list({ project })).toEqual([]);
		expect((await memory.search({ project }, "Python")).map((hit) => hit.snippet).join("\n")).not.toMatch(
			/Python 3\.(10|12)/u,
		);
		await fixture.restart();
		expect((await fixture.application.services.semantic.history(create.id, { project })).length).toBe(4);
	} finally {
		await fixture.close();
	}
});

test("external Markdown edits lose confirmation, retain stable identity/history and isolate scopes before vector recall", async () => {
	const fixture = await createAssistantFixture();
	try {
		const project = await fixture.application.createProject({ name: "外部编辑 中文 空格" });
		const other = await fixture.application.createProject({ name: "别的项目" });
		const memory = fixture.application.services.memory;
		const candidate = await memory.propose(
			{ project },
			{ kind: "project", proposedText: "项目使用 Python 3.12。", reason: "用户确认" },
		);
		await memory.accept(candidate.id);
		await writeFile(
			project.memoryFilePath,
			(await readFile(project.memoryFilePath, "utf8")).replace("Python 3.12", "Python 3.13"),
		);
		expect((await memory.search({ project }, "Python"))[0]?.snippet).toContain("unknown");
		const records = await fixture.application.services.semantic.list({ project });
		expect(records[0]).toMatchObject({
			id: candidate.id,
			version: 2,
			confirmation: "unknown",
			conflict: "external_edit",
		});
		expect((await fixture.application.services.semantic.history(candidate.id, { project }))[1]?.text).toContain(
			"3.12",
		);
		expect(await memory.search({ project: other }, "Python")).toEqual([]);
		await fixture.application.repositories.semantic.saveSemanticVector(
			candidate.id,
			2,
			"text-space:revision-1",
			[1, 0],
		);
		const query = { projectId: project.id, at: new Date().toISOString(), limit: 5 };
		expect(
			(
				await fixture.application.repositories.semantic.searchSemanticVectors(
					query,
					"text-space:revision-1",
					[1, 0],
				)
			)[0]?.id,
		).toBe(candidate.id);
		expect(
			await fixture.application.repositories.semantic.searchSemanticVectors(
				{ ...query, projectId: other.id },
				"text-space:revision-1",
				[1, 0],
			),
		).toEqual([]);
		expect(
			await fixture.application.repositories.semantic.searchSemanticVectors(query, "text-space:revision-2", [1, 0]),
		).toEqual([]);
		await expect(
			fixture.application.repositories.semantic.searchSemanticVectors(query, "text-space:revision-1", [1, 0, 0]),
		).rejects.toMatchObject({ code: "conflict" });
	} finally {
		await fixture.close();
	}
});

test.each(["before file replacement", "after file replacement", "external conflict"])(
	"write-ahead recovery handles %s without duplicate or lost data",
	async (point) => {
		const fixture = await createAssistantFixture();
		try {
			const project = await fixture.application.createProject({ name: "崩溃恢复" });
			const before = await readFile(project.memoryFilePath, "utf8");
			const after = `${before}\n## 可恢复事实\n文件和索引需要同步。\n`;
			await fixture.application.repositories.semantic.saveWriteIntent({
				id: "crash-write-intent",
				kind: "project",
				projectId: project.id,
				relativePath: `projects/${project.slug}/AGENTS.md`,
				before,
				after,
				beforeHash: hash(before),
				afterHash: hash(after),
				status: "prepared",
				createdAt: new Date().toISOString(),
			});
			if (point === "after file replacement") await writeFile(project.memoryFilePath, after);
			if (point === "external conflict") await writeFile(project.memoryFilePath, "用户的外部修改，必须保留。\n");
			await fixture.restart();
			expect(await readFile(project.memoryFilePath, "utf8")).toBe(
				point === "external conflict" ? "用户的外部修改，必须保留。\n" : after,
			);
			expect(await fixture.application.repositories.semantic.listWriteIntents()).toEqual([]);
			if (point !== "external conflict")
				expect((await fixture.application.services.memory.search({ project }, "同步"))[0]?.snippet).toContain(
					"同步",
				);
		} finally {
			await fixture.close();
		}
	},
);
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

test("updates reconcile external edits first, preserve unrelated uncertainty and reject copied cross-project identities", async () => {
	const fixture = await createAssistantFixture();
	try {
		const project = await fixture.application.createProject({ name: "外部同步" });
		const other = await fixture.application.createProject({ name: "锚点隔离" });
		const memory = fixture.application.services.memory;
		const first = await memory.propose(
			{ project },
			{ kind: "project", proposedText: "项目使用 Python 3.12。", reason: "确认" },
		);
		await memory.accept(first.id);
		await writeFile(project.memoryFilePath, (await readFile(project.memoryFilePath, "utf8")).replace("3.12", "3.13"));
		const unrelated = await memory.propose(
			{ project },
			{ kind: "project", proposedText: "文档以中文编写。", reason: "确认" },
		);
		await memory.accept(unrelated.id);
		expect(await fixture.application.repositories.semantic.getSemantic(first.id)).toMatchObject({
			version: 2,
			confirmation: "unknown",
			conflict: "external_edit",
			text: "项目使用 Python 3.13。",
		});
		await expect(
			memory.propose(
				{ project },
				{
					kind: "project",
					proposedText: "项目使用 Python 3.14。",
					reason: "迟到操作",
					semanticChange: { operation: "update", targetId: first.id, expectedVersion: 1 },
				},
			),
		).rejects.toMatchObject({ code: "conflict" });
		await writeFile(other.memoryFilePath, await readFile(project.memoryFilePath, "utf8"));
		await expect(memory.search({ project: other }, "Python")).rejects.toMatchObject({ code: "conflict" });
		expect(await fixture.application.repositories.semantic.getSemantic(first.id)).toMatchObject({
			projectId: project.id,
			version: 2,
		});
	} finally {
		await fixture.close();
	}
});

test("explicit update and merge resolve conflicting candidates, and future or expired facts stay out of current recall", async () => {
	const fixture = await createAssistantFixture();
	try {
		const project = await fixture.application.createProject({ name: "冲突 合并 生效" });
		const memory = fixture.application.services.memory;
		const semantic = fixture.application.services.semantic;
		const first = await memory.propose(
			{ project },
			{ kind: "project", proposedText: "项目发布前必须完成完整检查。", reason: "确认规则" },
		);
		await memory.accept(first.id);
		const contradiction = await memory.propose(
			{ project },
			{ kind: "project", proposedText: "项目发布前不必完成完整检查。", reason: "待裁定" },
		);
		expect(contradiction.semanticChange?.conflictIds).toContain(first.id);
		await memory.accept(contradiction.id);
		expect(await fixture.application.repositories.semantic.getSemantic(contradiction.id)).toMatchObject({
			conflict: "detected",
		});
		await semantic.change(
			{ project },
			{
				kind: "project",
				proposedText: "项目发布前必须完成完整检查，人工批准例外。",
				reason: "裁定合并",
				semanticChange: {
					operation: "merge",
					targetId: first.id,
					expectedVersion: 1,
					mergeIds: [contradiction.id],
				},
			},
		);
		expect(await fixture.application.repositories.semantic.getSemantic(contradiction.id)).toMatchObject({
			status: "superseded",
			supersededBy: first.id,
		});
		await semantic.change(
			{ project },
			{
				kind: "project",
				proposedText: "项目发布前必须完成完整检查和构建。",
				reason: "明确更新",
				semanticChange: { operation: "update", targetId: first.id, expectedVersion: 2 },
			},
		);
		expect((await semantic.history(first.id, { project })).map((value) => value.version)).toEqual([3, 2, 1]);
		const future = await memory.propose(
			{ project },
			{
				kind: "project",
				proposedText: "FUTURE-ONLY 下一代政策。",
				reason: "未来生效",
				semanticChange: { operation: "create", validFrom: "2099-01-01T00:00:00.000Z" },
			},
		);
		await memory.accept(future.id);
		const expired = await memory.propose(
			{ project },
			{
				kind: "project",
				proposedText: "EXPIRED-ONLY 旧政策。",
				reason: "导入历史",
				semanticChange: {
					operation: "create",
					validFrom: "2000-01-01T00:00:00.000Z",
					validUntil: "2001-01-01T00:00:00.000Z",
				},
			},
		);
		await memory.accept(expired.id);
		expect(await memory.search({ project }, "FUTURE-ONLY")).toEqual([]);
		expect(await memory.search({ project }, "EXPIRED-ONLY")).toEqual([]);
		expect((await semantic.list({ project }, true)).map((value) => value.id)).toContain(future.id);
	} finally {
		await fixture.close();
	}
});
