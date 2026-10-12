import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import type { RuntimeCommandResult, RuntimeSlashCommand } from "@earendil-works/workbench-runtime";
import { expect, test } from "vitest";
import { BUILTIN_SLASH_COMMANDS } from "../../coding-agent/src/core/slash-commands.ts";
import { createAssistantFixture } from "./assistant-fixture.ts";

test("the command catalog covers the current Pi builtins and command messages never reach the model", async () => {
	const fixture = await createAssistantFixture();
	try {
		const catalog = await fixture.request("/runtime/commands");
		expect(catalog.status).toBe(200);
		const commands = (await catalog.json()) as RuntimeSlashCommand[];
		expect(commands.map((command) => command.name)).toEqual(BUILTIN_SLASH_COMMANDS.map((command) => command.name));
		expect(
			commands
				.filter((command) => command.action === "unsupported")
				.every((command) => Boolean(command.unavailableReason)),
		).toBe(true);
		const session = await fixture.application.createSession({});
		const response = await fixture.request(`/sessions/${session.id}/messages`, {
			method: "POST",
			body: JSON.stringify({ text: "/name 测试" }),
		});
		expect(response.status).toBe(400);
		expect(await fixture.application.services.sessions.readTranscript(session.id)).toEqual([]);
	} finally {
		await fixture.close();
	}
});

test("public Pi stats, HTML/JSONL export and compaction preserve the session and clean export temp files", async () => {
	const fixture = await createAssistantFixture();
	try {
		await writeFile(
			join(fixture.root, "pi-agent", "settings.json"),
			JSON.stringify({ compaction: { enabled: false, keepRecentTokens: 32, reserveTokens: 64 } }),
		);
		const session = await fixture.application.createSession({ title: "原生命令验收" });
		fixture.faux.setResponses([
			fauxAssistantMessage("第一轮".repeat(80)),
			fauxAssistantMessage("第二轮".repeat(80)),
			fauxAssistantMessage("第三轮".repeat(80)),
			fauxAssistantMessage("已完成三轮工作，接下来继续核对任务。"),
			fauxAssistantMessage("保留当前轮次的资料和核对目标。"),
		]);
		for (let index = 0; index < 3; index++) {
			const submitted = await fixture.request(`/sessions/${session.id}/messages`, {
				method: "POST",
				body: JSON.stringify({ text: `第 ${index} 轮资料：${"项目资料".repeat(100)}` }),
			});
			expect(submitted.status).toBe(202);
			const { runId } = (await submitted.json()) as { runId: string };
			for await (const entry of fixture.application.events.subscribe(runId))
				expect(entry.event.type).not.toBe("run.failed");
		}
		const execute = async (command: object) => {
			const response = await fixture.request(`/sessions/${session.id}/commands`, {
				method: "POST",
				body: JSON.stringify(command),
			});
			expect(response.status, await response.clone().text()).toBe(200);
			return response.json() as Promise<RuntimeCommandResult>;
		};
		expect(await execute({ name: "session" })).toMatchObject({
			type: "stats",
			userMessages: 3,
			assistantMessages: 3,
		});
		const filesBeforeExport = await readdir(fixture.application.paths.piSessions);
		for (const format of ["html", "jsonl"]) {
			const result = await execute({ name: "export", format });
			if (result.type !== "export") throw new Error("Missing export result");
			const history =
				format === "html"
					? Buffer.from(
							result.content.match(
								/<script id="session-data" type="application\/json">([^<]+)<\/script>/u,
							)?.[1] ?? "",
							"base64",
						).toString("utf8")
					: result.content;
			expect(history.includes("第一轮")).toBe(true);
			expect(result.fileName).toMatch(new RegExp(`\\.${format}$`));
			expect(await readdir(fixture.application.paths.piSessions)).toEqual(filesBeforeExport);
			if (format === "jsonl") expect(JSON.parse(result.content.split("\n")[0]).id).toBe(session.runtimeSessionId);
		}
		const compact = await execute({ name: "compact", instructions: "保留任务目标" });
		expect(compact).toMatchObject({
			type: "compaction",
			summary: expect.stringContaining("已完成三轮工作，接下来继续核对任务。"),
		});
		expect(await readFile(session.runtimeRef, "utf8")).toContain('"type":"compaction"');
		expect((await fixture.application.services.sessions.get(session.id)).runtimeSessionId).toBe(
			session.runtimeSessionId,
		);
		const bad = await fixture.request(`/sessions/${session.id}/commands`, {
			method: "POST",
			body: JSON.stringify({ name: "export", format: "jsonl", path: "C:/Users/user/private.jsonl" }),
		});
		expect(bad.status).toBe(400);
		await fixture.restart();
		const stats = await fixture.request(`/sessions/${session.id}/commands`, {
			method: "POST",
			body: JSON.stringify({ name: "session" }),
		});
		expect(stats.status).toBe(200);
		expect((await fixture.application.services.sessions.get(session.id)).runtimeSessionId).toBe(
			session.runtimeSessionId,
		);
	} finally {
		await fixture.close();
	}
}, 60_000);
