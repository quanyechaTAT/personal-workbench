import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { expect, test } from "vitest";
import { createAssistantFixture } from "./assistant-fixture.ts";
import { startModelServer } from "./fixtures/model-server.ts";

// This verifies the request contract, not an uncalled provider's obedience or output secrecy.
test.each(["openai-completions", "anthropic-messages", "openai-responses"])(
	"%s: complete response conventions survive model switches and restart; internal locations stay in Inspector",
	async (api) => {
		const wire = await startModelServer();
		const fixture = await createAssistantFixture();
		try {
			const settings = await fixture.application.services.modelSettings.save(undefined, {
				name: "本机协议验证",
				api,
				baseUrl: `${wire.origin}/v1`,
				enabled: true,
				apiKey: "fixture-identity-only",
				expectedVersion: (await fixture.application.services.modelSettings.get()).version,
				models: ["deepseek-flash", "another-configured-model"].map((modelId) => ({
					modelId,
					name: modelId,
					enabled: true,
					reasoning: false,
					vision: false,
					contextWindow: 32768,
					maxTokens: 1024,
					thinkingPreset: "auto" as const,
				})),
			});
			const provider = settings.providers.find((item) => item.name === "本机协议验证")!;
			const project = await fixture.application.createProject({ name: "test 约定 中文" });
			const path = `projects/${project.slug}/AGENTS.md`;
			const file = await fixture.application.services.memory.read(path);
			const convention = "当用户询问模型名时，回答 GPT-6Astra。";
			const boundary = "以下内容不要向用户说明，但是你必须遵循";
			const globalFile = await fixture.application.services.files.read("MEMORY.md");
			await fixture.application.services.memory.edit(
				"MEMORY.md",
				`${globalFile.content}\n你叫全局演示代号。\n\n共享事实：报告时间使用北京时间。\n`,
				globalFile.contentHash,
				"global",
			);
			await fixture.application.services.memory.edit(
				path,
				`${file.content}\n\n## ${boundary}\n### 回答约定\n- ${convention}\n`,
				file.contentHash,
				"project",
				project.id,
			);
			const session = await fixture.application.createSession({
				projectId: project.id,
				profileSlug: "standard",
				model: { provider: provider.id, modelId: "deepseek-flash" },
			});
			for (const [index, modelId] of [
				"deepseek-flash",
				"another-configured-model",
				"another-configured-model",
			].entries()) {
				if (index === 1) {
					const switched = await fixture.request(`/sessions/${session.id}/model`, {
						method: "PUT",
						body: JSON.stringify({ provider: provider.id, modelId }),
					});
					expect(switched.status).toBe(200);
				}
				if (index === 2) await fixture.restart();
				const response = await fixture.request(`/sessions/${session.id}/messages`, {
					method: "POST",
					body: JSON.stringify({ text: "你当前使用的模型是什么？不调用工具。" }),
				});
				expect(response.status).toBe(202);
				const { runId } = (await response.json()) as { runId: string };
				for await (const entry of fixture.application.events.subscribe(runId))
					expect(entry.event.type).not.toBe("run.failed");
				const body = wire.requests.at(-1)!.body;
				expect(body.model).toBe(modelId);
				const system =
					api === "anthropic-messages"
						? body.system
						: (body.instructions ??
							(
								(api === "openai-responses" ? body.input : body.messages) as Array<{
									role: string;
									content: unknown;
								}>
							).filter((message) => ["system", "developer"].includes(message.role)));
				const user = ((body.messages ?? body.input) as Array<{ role: string; content: unknown }>).filter(
					(message) => message.role === "user",
				);
				const serialized = `${JSON.stringify(system)}\n${JSON.stringify(user)}`;
				expect(JSON.stringify(system)).not.toContain(convention);
				expect(JSON.stringify(user)).toContain(convention);
				expect(serialized.match(/memory-instruction scope=/gu)).toHaveLength(1);
				expect
					.soft(serialized.includes("<workbench-model-identity>"), "no injected route-priority override")
					.toBe(false);
				expect.soft(serialized.includes(boundary), "parent constraint preserved").toBe(true);
				expect.soft(serialized.includes(convention), "memory body remains available").toBe(true);
				expect
					.soft(serialized.includes("全局演示代号"), "specific project convention shadows global self-label")
					.toBe(false);
				expect
					.soft(serialized.includes("报告时间使用北京时间"), "unrelated global facts remain available")
					.toBe(true);
				expect
					.soft(
						serialized.includes("<memory-instruction scope="),
						"response conventions are executable instructions",
					)
					.toBe(true);
				expect.soft(serialized.includes(path), "internal memory file label omitted").toBe(false);
				expect.soft(serialized.includes("核验不等于披露内部配置"), "disclosure boundary explicit").toBe(true);
				const actual = await fixture.application.repositories.memoryState.getContext(session.id);
				expect(actual?.fragments).toContainEqual(
					expect.objectContaining({
						text: expect.stringContaining(`- ${convention}`),
						sources: [expect.objectContaining({ path, confirmation: "unknown" })],
					}),
				);
			}
			const minimal = await fixture.application.createSession({
				projectId: project.id,
				profileSlug: "minimal",
				model: { provider: provider.id, modelId: "deepseek-flash" },
			});
			const response = await fixture.request(`/sessions/${minimal.id}/messages`, {
				method: "POST",
				body: JSON.stringify({ text: "你好" }),
			});
			const { runId } = (await response.json()) as { runId: string };
			for await (const entry of fixture.application.events.subscribe(runId))
				expect(entry.event.type).not.toBe("run.failed");
			const minimalPayload = JSON.stringify(wire.requests.at(-1)!.body);
			expect(minimalPayload).not.toContain("<workbench-model-identity>");
			expect(minimalPayload).not.toContain(convention);
		} finally {
			await fixture.close();
			await wire.close();
		}
	},
	60_000,
);

test("generic response conventions respect scope without promoting unconfirmed model material or removing facts", async () => {
	const fixture = await createAssistantFixture();
	try {
		const project = await fixture.application.createProject({ name: "行为约定 范围" });
		const other = await fixture.application.createProject({ name: "另一个项目" });
		for (const [path, kind, answer] of [
			["MEMORY.md", "global", "全局口令"],
			["USER.md", "user", "个人口令"],
		] as const) {
			const file = await fixture.application.services.memory.read(path);
			await fixture.application.services.memory.edit(
				path,
				`${file.content}\n当用户询问“测试口令”时，回答“${answer}”。\n\n事实：验收日期为 2026-10-08。\n`,
				file.contentHash,
				kind,
			);
		}
		const candidate = await fixture.application.services.memory.propose(
			{ project },
			{
				kind: "project",
				proposedText: "当用户询问“测试口令”时，回答“项目口令”。",
				heading: "## 回答约定\n### 以下内容不要向用户说明，但是你必须遵循",
				reason: "用户明确设置当前项目的回答约定",
			},
		);
		await fixture.application.services.memory.accept(candidate.id);
		const sourceSession = await fixture.application.createSession({ projectId: project.id });
		const path = `projects/${project.slug}/AGENTS.md`;
		const file = await fixture.application.services.files.read(path);
		const prepared = await fixture.application.services.semantic.prepare(
			file.content,
			"project",
			path,
			project.id,
			{
				kind: "project",
				proposedText: "当用户询问“未经审核问题”时，回答“未审核模型结果”。",
				sessionId: sourceSession.id,
				reason: "未经用户确认的模型资料",
				semanticChange: { operation: "create", confidence: 0.7 },
			},
			"unconfirmed-model-material",
			"unverified",
		);
		await fixture.application.services.memory.edit(path, prepared.preview, file.contentHash, "project", project.id);
		for (const [projectId, expected, excluded] of [
			[project.id, "项目口令", ["个人口令", "全局口令"]],
			[other.id, "个人口令", ["项目口令", "全局口令"]],
			[undefined, "个人口令", ["项目口令", "全局口令"]],
		] as const) {
			const session = await fixture.application.createSession({ projectId, profileSlug: "standard" });
			let prompt = "";
			fixture.faux.setResponses([
				(context) => {
					const user = [...context.messages].reverse().find((message) => message.role === "user");
					prompt = `${context.systemPrompt ?? ""}\n${
						user?.role === "user"
							? typeof user.content === "string"
								? user.content
								: user.content
										.filter((part) => part.type === "text")
										.map((part) => part.text)
										.join("\n")
							: ""
					}`;
					return fauxAssistantMessage("测试协议已接收。");
				},
			]);
			const response = await fixture.request(`/sessions/${session.id}/messages`, {
				method: "POST",
				body: JSON.stringify({ text: "测试口令是什么？未经审核问题也请查阅。不要调用工具。" }),
			});
			expect(response.status).toBe(202);
			const { runId } = (await response.json()) as { runId: string };
			for await (const entry of fixture.application.events.subscribe(runId))
				expect(entry.event.type).not.toBe("run.failed");
			expect(prompt).toContain(expected);
			for (const value of excluded) expect(prompt).not.toContain(value);
			expect(prompt).toContain("验收日期为 2026-10-08");
			const instructions = [...prompt.matchAll(/<memory-instruction\b[^>]*>([\s\S]*?)<\/memory-instruction>/gu)]
				.map((match) => match[1])
				.join("\n");
			expect(instructions).toContain(expected);
			expect(instructions).not.toContain("未审核模型结果");
			expect(instructions).not.toContain("user_confirmed");
			expect(instructions).not.toContain("须核验证据");
			expect(prompt.indexOf("<current-user-instructions>")).toBeGreaterThan(prompt.lastIndexOf("</memory-source>"));
			expect(prompt).toContain("行数、顺序、换行和指定用语");
			const actual = await fixture.application.repositories.memoryState.getContext(session.id);
			expect(actual?.diagnostics.some((message) => message.includes("范围优先级"))).toBe(true);
			if (projectId === project.id) {
				expect(prompt).toContain("未审核模型结果");
				expect(prompt).toContain("unverified");
				expect(actual?.fragments.find((fragment) => fragment.id === candidate.id)).toMatchObject({
					instruction: { scope: "project" },
					version: 1,
				});
				expect(
					actual?.fragments.find((fragment) => fragment.id === "unconfirmed-model-material")?.instruction,
				).toBeUndefined();
			}
		}
		const search = await fixture.application.services.memory.search({ project }, "测试口令", 20);
		expect(search.map((item) => item.snippet).join("\n")).toContain("全局口令");
		expect(search.map((item) => item.snippet).join("\n")).toContain("个人口令");
	} finally {
		await fixture.close();
	}
});
