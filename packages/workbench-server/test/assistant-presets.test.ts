import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import type { AgentEvent } from "@earendil-works/workbench-runtime";
import { expect, test } from "vitest";
import { createAssistantFixture } from "./assistant-fixture.ts";

async function run(fixture: Awaited<ReturnType<typeof createAssistantFixture>>, sessionId: string) {
	const context = await fixture.application.contextForSession(sessionId);
	const { runId } = fixture.application.events.start(sessionId, { text: "验证助手模式", context: context.runtime });
	const events: AgentEvent[] = [];
	for await (const entry of fixture.application.events.subscribe(runId))
		if (entry.event.type !== "stream.reset") events.push(entry.event);
	return events;
}

test("four distinct presets replace the previous defaults and Standard remains the default", async () => {
	const fixture = await createAssistantFixture();
	try {
		const profiles = await fixture.application.services.profiles.list(true);
		expect(profiles.map((profile) => profile.slug).sort()).toEqual(["creator", "minimal", "ptc", "standard"]);
		expect(profiles.map((profile) => profile.name).sort()).toEqual(
			["PTC助手", "创造助手", "极简助手", "标准助手"].sort(),
		);
		expect(profiles.find((profile) => profile.slug === "minimal")?.tools).toEqual(["persistent_shell"]);
		expect(profiles.find((profile) => profile.slug === "ptc")?.tools).toContain("run_code");
		expect(profiles.find((profile) => profile.slug === "standard")?.tools).not.toContain("run_code");
		expect(profiles.find((profile) => profile.slug === "creator")?.tools).toContain("assistant_create");
		const session = await fixture.application.createSession({});
		expect(session.agentProfileId).toBe(profiles.find((profile) => profile.slug === "standard")?.id);
		await fixture.restart();
		expect(await fixture.application.services.profiles.list(true)).toEqual(profiles);
	} finally {
		await fixture.close();
	}
});

test("Minimal keeps shell variables across calls without injecting skills or workspace context", async () => {
	const fixture = await createAssistantFixture();
	try {
		const session = await fixture.application.createSession({ profileSlug: "minimal" });
		const context = await fixture.application.contextForSession(session.id, "项目记忆");
		expect(context.sources).toEqual([]);
		expect(context.turn).toBeUndefined();
		expect((await fixture.application.chatCapabilities({ sessionId: session.id })).items).toEqual([]);
		const skill = (await fixture.application.services.skills.list())[0];
		await expect(
			fixture.application.services.sessions.prepareInvocation(session.id, "不能注入技能", { skillId: skill.id }),
		).rejects.toMatchObject({ code: "invalid_input" });
		await fixture.application.services.permissions.setMode(session.id, "full-access");
		fixture.faux.setResponses([
			fauxAssistantMessage(
				fauxToolCall("persistent_shell", { command: "$workbenchProbe = 41; Write-Output initialized" }),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(fauxToolCall("persistent_shell", { command: "Write-Output ($workbenchProbe + 1)" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("完成"),
		]);
		const events = await run(fixture, session.id);
		const results = events.filter((event) => event.type === "tool.completed");
		expect(results).toHaveLength(2);
		expect(results.every((event) => !event.data.isError)).toBe(true);
		expect(JSON.stringify(results[1])).toContain("42");
	} finally {
		await fixture.close();
	}
}, 30_000);

test("PTC exposes only run_code, filters tool results in TypeScript, records nested calls and blocks protected paths", async () => {
	const fixture = await createAssistantFixture();
	try {
		const privatePath = join(fixture.root, "pi-agent", "private.txt");
		await writeFile(privatePath, "never-visible-secret");
		const session = await fixture.application.createSession({ profileSlug: "ptc" });
		await writeFile(join(session.cwd, "input.txt"), "unneeded-detail\nanswer=42");
		await fixture.application.services.permissions.setMode(session.id, "full-access");
		let observedFilteredRequest = false;
		fixture.faux.setResponses([
			fauxAssistantMessage(
				fauxToolCall(
					"run_code",
					{
						code: `const result = await tools.read({ path: "input.txt" }); const answer: string | undefined = result.content.find(part => part.type === "text")?.text.match(/answer=\\d+/)?.[0]; console.log(answer); try { await tools.read({ path: ${JSON.stringify(privatePath)} }); } catch { console.log("protected"); }`,
					},
					{ id: "ptc-probe" },
				),
				{ stopReason: "toolUse" },
			),
			(context) => {
				expect(context.tools?.map((tool) => tool.name)).toEqual(["run_code"]);
				const result = context.messages.find((message) => message.role === "toolResult");
				expect(JSON.stringify(result?.content)).toContain("answer=42");
				expect(JSON.stringify(result?.content)).not.toContain("unneeded-detail");
				observedFilteredRequest = true;
				return fauxAssistantMessage("完成");
			},
		]);
		const events = await run(fixture, session.id);
		const results = events.filter((event) => event.type === "tool.completed");
		expect(results.filter((event) => event.data.toolName === "read")).toHaveLength(2);
		const program = results.find((event) => event.data.toolName === "run_code");
		expect(program?.data.isError, JSON.stringify(events)).toBe(false);
		expect(JSON.stringify(program?.data.result)).toContain("answer=42");
		expect(JSON.stringify(events)).not.toContain("never-visible-secret");
		expect(observedFilteredRequest).toBe(true);
		await fixture.restart();
		expect(JSON.stringify(await fixture.application.services.sessions.readTranscript(session.id))).toContain(
			"input.txt",
		);
	} finally {
		await fixture.close();
	}
}, 30_000);

test("Creator saves a validated assistant that is selectable immediately and survives restart", async () => {
	const fixture = await createAssistantFixture();
	try {
		const session = await fixture.application.createSession({ profileSlug: "creator" });
		fixture.faux.setResponses([
			fauxAssistantMessage(
				fauxToolCall("assistant_create", {
					name: "代码审查助手",
					description: "检查缺陷与测试缺口",
					systemPrompt: "审查代码，引用文件和行号。",
					tools: ["read", "grep"],
					skillIds: [],
					mcpBindings: [],
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("已创建"),
		]);
		const events = await run(fixture, session.id);
		expect(
			events.some(
				(event) =>
					event.type === "tool.completed" && event.data.toolName === "assistant_create" && !event.data.isError,
			),
		).toBe(true);
		const profile = (await fixture.application.services.profiles.list()).find(
			(item) => item.name === "代码审查助手",
		)!;
		expect(profile.tools).toEqual(["read", "grep"]);
		expect(profile.isBuiltin).toBe(false);
		expect((await fixture.application.createSession({ profileId: profile.id })).agentProfileId).toBe(profile.id);
		await fixture.restart();
		expect(await fixture.application.services.profiles.get(profile.id)).toEqual(profile);
	} finally {
		await fixture.close();
	}
});

test("migrating the three legacy assistants preserves session IDs, model selection and historical revisions", async () => {
	const fixture = await createAssistantFixture();
	try {
		const custom = await fixture.application.services.profiles.create({
			name: "已有自定义助手",
			systemPrompt: "保留用户配置",
			tools: ["read"],
		});
		const migrated = [];
		for (const [slug, legacySlug] of [
			["standard", "general"],
			["minimal", "research"],
			["ptc", "coding"],
		]) {
			const current = await fixture.application.services.profiles.getBySlug(slug);
			const legacy = {
				...current,
				slug: legacySlug,
				name: legacySlug,
				systemPrompt: "Legacy instructions",
				defaultModel: { provider: fixture.model.provider, modelId: fixture.model.id },
				tools: ["read"],
				skillIds: [],
				version: current.version + 1,
			};
			expect(await fixture.application.repositories.profiles.upsert(legacy, current.version)).toEqual(legacy);
			migrated.push({ slug, legacy });
		}
		const standard = migrated.find((item) => item.slug === "standard")!.legacy;
		const project = await fixture.application.createProject({ name: "已有项目", defaultProfileId: standard.id });
		const session = await fixture.application.createSession({ projectId: project.id, profileId: standard.id });
		await fixture.application.services.profiles.setDefault(standard.id);
		await fixture.application.services.settings.set("agent.defaultMode", "general");
		fixture.faux.setResponses([fauxAssistantMessage("已有会话内容")]);
		await run(fixture, session.id);
		await fixture.restart();
		for (const { slug, legacy } of migrated) {
			const profile = await fixture.application.services.profiles.getBySlug(slug);
			expect(profile).toMatchObject({
				id: legacy.id,
				defaultModel: legacy.defaultModel,
				version: legacy.version + 1,
			});
			expect((await fixture.application.services.profiles.getRevision(legacy.id, legacy.version)).config).toEqual(
				legacy,
			);
			await expect(fixture.application.services.profiles.getBySlug(legacy.slug)).rejects.toMatchObject({
				code: "not_found",
			});
		}
		expect(await fixture.application.services.profiles.get(custom.id)).toEqual({ ...custom, bindingDiagnostics: [] });
		expect((await fixture.application.services.sessions.get(session.id)).agentProfileId).toBe(standard.id);
		expect((await fixture.application.services.projects.get(project.id)).defaultProfileId).toBe(standard.id);
		expect((await fixture.application.createSession({})).agentProfileId).toBe(standard.id);
		expect((await fixture.application.services.settings.get("agent.defaultMode"))?.value).toBe("standard");
		expect(JSON.stringify(await fixture.application.services.sessions.readTranscript(session.id))).toContain(
			"已有会话内容",
		);
		const profiles = await fixture.application.services.profiles.list(true);
		expect(profiles).toHaveLength(5);
		await fixture.restart();
		expect(await fixture.application.services.profiles.list(true)).toEqual(profiles);
	} finally {
		await fixture.close();
	}
});

test("Creator inspects capabilities, rejects unknown tools and requires the current version when updating", async () => {
	const fixture = await createAssistantFixture();
	try {
		const target = await fixture.application.services.profiles.create({
			name: "待修改助手",
			systemPrompt: "旧指令",
			tools: ["read"],
		});
		const session = await fixture.application.createSession({ profileSlug: "creator" });
		fixture.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("assistant_catalog", {}, { id: "catalog" }), { stopReason: "toolUse" }),
			fauxAssistantMessage(
				fauxToolCall(
					"assistant_create",
					{ name: "无效助手", systemPrompt: "不能保存未知工具", tools: ["unknown_tool"] },
					{ id: "invalid-create" },
				),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(fauxToolCall("assistant_inspect", { id: target.id }, { id: "inspect" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage(
				fauxToolCall(
					"assistant_update",
					{
						id: target.id,
						expectedVersion: target.version,
						name: target.name,
						systemPrompt: "新指令",
						tools: ["read", "grep"],
					},
					{ id: "update" },
				),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(
				fauxToolCall(
					"assistant_update",
					{
						id: target.id,
						expectedVersion: target.version,
						name: target.name,
						systemPrompt: "过期指令",
						tools: ["write"],
					},
					{ id: "stale-update" },
				),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("完成"),
		]);
		const events = await run(fixture, session.id);
		const results = events.filter((event) => event.type === "tool.completed");
		for (const id of ["catalog", "inspect", "update"])
			expect(results.find((event) => event.data.toolCallId === id)?.data.isError).toBe(false);
		for (const id of ["invalid-create", "stale-update"])
			expect(results.find((event) => event.data.toolCallId === id)?.data.isError).toBe(true);
		expect((await fixture.application.services.profiles.list()).some((profile) => profile.name === "无效助手")).toBe(
			false,
		);
		expect(await fixture.application.services.profiles.get(target.id)).toMatchObject({
			version: target.version + 1,
			systemPrompt: "新指令",
			tools: ["read", "grep"],
		});
	} finally {
		await fixture.close();
	}
});

test("PTC rejects direct host access and retains nested calls when the program throws", async () => {
	const fixture = await createAssistantFixture();
	try {
		const profile = await fixture.application.services.profiles.create({
			name: "限制 PTC",
			systemPrompt: "只读取",
			tools: ["run_code", "read"],
		});
		const session = await fixture.application.createSession({ profileId: profile.id });
		await writeFile(join(session.cwd, "audit.txt"), "recorded");
		fixture.faux.setResponses([
			fauxAssistantMessage(
				fauxToolCall("run_code", {
					code: `console.log(typeof process, typeof require, typeof fetch, typeof tools.write); try { console.log(console.log.constructor("return process")()); } catch { console.log("generation blocked"); } try { await import("node:fs"); } catch { console.log("import blocked"); } await tools.read({ path: "audit.txt" }); throw new Error("failed after read");`,
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("程序失败"),
		]);
		const events = await run(fixture, session.id);
		const result = events.find((event) => event.type === "tool.completed" && event.data.toolName === "run_code");
		expect(result?.type === "tool.completed" && result.data.isError).toBe(true);
		expect(JSON.stringify(result)).toContain("undefined undefined undefined undefined");
		expect(JSON.stringify(result)).toContain("generation blocked");
		expect(JSON.stringify(result)).toContain("import blocked");
		await fixture.restart();
		const transcript = JSON.stringify(await fixture.application.services.sessions.readTranscript(session.id));
		expect(transcript).toContain("audit.txt");
		expect(transcript).toContain("recorded");
		expect(transcript).toContain("failed after read");
	} finally {
		await fixture.close();
	}
}, 20_000);

test("preset migration preserves custom assistants whose slugs collide with the new built-ins", async () => {
	const fixture = await createAssistantFixture();
	try {
		const legacyIds = new Map<string, string>();
		for (const [slug, legacySlug] of [
			["standard", "general"],
			["minimal", "research"],
			["ptc", "coding"],
		]) {
			const current = await fixture.application.services.profiles.getBySlug(slug);
			await fixture.application.repositories.profiles.upsert(
				{ ...current, slug: legacySlug, version: current.version + 1 },
				current.version,
			);
			legacyIds.set(slug, current.id);
		}
		const creator = await fixture.application.services.profiles.getBySlug("creator");
		await fixture.application.repositories.profiles.upsert(
			{ ...creator, isBuiltin: false, name: "已有创造工具", version: creator.version + 1 },
			creator.version,
		);
		const customProfiles = [await fixture.application.services.profiles.get(creator.id)];
		for (const name of ["standard", "minimal", "ptc"])
			customProfiles.push(
				await fixture.application.services.profiles.create({
					name,
					systemPrompt: `用户配置 ${name}`,
					tools: ["read"],
				}),
			);
		await fixture.application.services.profiles.setDefault(customProfiles[1].id);
		const session = await fixture.application.createSession({ profileId: customProfiles[1].id });
		await fixture.restart();
		for (const slug of ["standard", "minimal", "ptc", "creator"]) {
			const builtin = await fixture.application.services.profiles.getBySlug(slug);
			expect(builtin.isBuiltin).toBe(true);
			if (legacyIds.has(slug)) expect(builtin.id).toBe(legacyIds.get(slug));
		}
		for (const custom of customProfiles) {
			const saved = await fixture.application.services.profiles.get(custom.id);
			expect(saved).toMatchObject({
				name: custom.name,
				systemPrompt: custom.systemPrompt,
				tools: custom.tools,
				isBuiltin: false,
				version: custom.version + 1,
			});
			expect(saved.slug).not.toBe(custom.slug);
			expect(
				(await fixture.application.services.profiles.getRevision(custom.id, custom.version)).config,
			).toMatchObject({
				slug: custom.slug,
				name: custom.name,
				systemPrompt: custom.systemPrompt,
				tools: custom.tools,
				version: custom.version,
			});
		}
		expect((await fixture.application.services.sessions.get(session.id)).agentProfileId).toBe(customProfiles[1].id);
		expect((await fixture.application.createSession({})).agentProfileId).toBe(customProfiles[1].id);
		const profiles = await fixture.application.services.profiles.list(true);
		expect(profiles).toHaveLength(8);
		await fixture.restart();
		expect(await fixture.application.services.profiles.list(true)).toEqual(profiles);
	} finally {
		await fixture.close();
	}
});

test("PTC timeout cancels pending approval and never executes the nested command", async () => {
	const fixture = await createAssistantFixture();
	try {
		const session = await fixture.application.createSession({ profileSlug: "ptc" });
		fixture.faux.setResponses([
			fauxAssistantMessage(
				fauxToolCall("run_code", {
					code: 'await tools.powershell({ command: "Set-Content timeout-denied.txt executed" });',
					timeout: 2,
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("超时已取消"),
		]);
		const events = await run(fixture, session.id);
		expect(events.some((event) => event.type === "permission.requested")).toBe(true);
		expect(await fixture.application.repositories.approvals.listPending()).toEqual([]);
		await expect(readFile(join(session.cwd, "timeout-denied.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
		await fixture.application.services.permissions.setMode(session.id, "full-access");
		await fixture.restart();
		expect(JSON.stringify(await fixture.application.services.sessions.readTranscript(session.id))).toContain(
			"powershell",
		);
		expect(JSON.stringify(events)).toContain("超时");
	} finally {
		await fixture.close();
	}
}, 15_000);
