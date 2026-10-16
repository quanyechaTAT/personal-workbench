import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type Context, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { expect, test, vi } from "vitest";
import { createAssistantFixture } from "./assistant-fixture.ts";

test("long commands yield a terminal session, accept input and return subsequent output and exit code", async () => {
	const fixture = await createAssistantFixture();
	try {
		const session = await fixture.application.createSession({ profileSlug: "standard" });
		await fixture.application.services.permissions.setMode(session.id, "full-access");
		const script = join(session.cwd, "interactive.cjs");
		await writeFile(
			script,
			'const r = require("node:readline").createInterface({ input: process.stdin }); console.log("terminal-ready"); r.on("line", line => { console.log("received:" + line); if (line === "quit") process.exit(7); });',
		);
		let terminalId = "missing";
		const results: unknown[] = [];
		const failures: boolean[] = [];
		let output = "";
		let phase: "ready" | "input" | "exit" = "ready";
		let polls = 0;
		const continueTerminal = (context: Context) => {
			const result = context.messages.at(-1);
			if (result?.role !== "toolResult") throw new Error("Expected terminal tool result");
			const details = result.details;
			if (
				typeof details !== "object" ||
				details === null ||
				!("session_id" in details) ||
				typeof details.session_id !== "string" ||
				!("output" in details) ||
				typeof details.output !== "string"
			)
				throw new Error(`Invalid terminal result: ${JSON.stringify(result)}`);
			results.push(details);
			terminalId = details.session_id;
			output += details.output;
			if (phase === "exit" && "status" in details && details.status === "exited") {
				failures.push(result.isError);
				return fauxAssistantMessage("完成");
			}
			if (++polls > 60) throw new Error(`Terminal did not finish: ${output}`);
			let chars: string | undefined;
			if (phase === "ready" && output.includes("terminal-ready")) {
				chars = "中文输入\r";
				phase = "input";
			} else if (phase === "input" && output.includes("received:中文输入")) {
				chars = "quit\r";
				phase = "exit";
			}
			fixture.faux.appendResponses([continueTerminal]);
			return fauxAssistantMessage(
				fauxToolCall("write_stdin", { session_id: terminalId, chars, yield_time_ms: 250 }),
				{ stopReason: "toolUse" },
			);
		};
		fixture.faux.setResponses([
			fauxAssistantMessage(
				fauxToolCall("exec_command", {
					command: `& '${process.execPath.replaceAll("'", "''")}' '${script.replaceAll("'", "''")}'`,
					yield_time_ms: 0,
				}),
				{ stopReason: "toolUse" },
			),
			continueTerminal,
		]);
		const context = await fixture.application.contextForSession(session.id);
		const run = fixture.application.events.start(session.id, { text: "启动终端并输入", context: context.runtime });
		for await (const _entry of fixture.application.events.subscribe(run.runId)) {
			/* drain */
		}
		expect(results[0]).toMatchObject({ status: "running", session_id: expect.any(String), exit_code: null });
		expect(JSON.stringify(results)).toContain("received:中文输入");
		expect(results.at(-1)).toMatchObject({ status: "exited", exit_code: 7 });
		expect(failures).toEqual([true]);
	} finally {
		await fixture.close();
	}
}, 30_000);

for (const profile of ["standard", "minimal", "ptc"] as const) {
	test(`${profile} keeps a dev server across turns and Stop kills it while the next command waits for approval`, async () => {
		const fixture = await createAssistantFixture();
		try {
			const session = await fixture.application.createSession({ profileSlug: profile });
			await fixture.application.services.permissions.setMode(session.id, "full-access");
			const script = join(session.cwd, "server.cjs");
			await writeFile(
				script,
				'const server = require("node:http").createServer((q,r) => r.end("dev-server-alive")); server.listen(0, "127.0.0.1", () => require("node:fs").writeFileSync("port.txt", String(server.address().port)));',
			);
			await writeFile(join(session.cwd, "other.txt"), "another-tool-can-run");
			const command = `& '${process.execPath.replaceAll("'", "''")}' '${script.replaceAll("'", "''")}'`;
			const tool = profile === "minimal" ? "persistent_shell" : profile === "ptc" ? "run_code" : "exec_command";
			const arguments_ =
				profile === "minimal"
					? { action: "exec", command, yield_time_ms: 0 }
					: profile === "ptc"
						? {
								code: `console.log((await tools.exec_command(${JSON.stringify({ command, yield_time_ms: 0 })})).details);`,
							}
						: { command, yield_time_ms: 0 };
			fixture.faux.setResponses([
				fauxAssistantMessage(fauxToolCall(tool, arguments_), { stopReason: "toolUse" }),
				fauxAssistantMessage("服务器后台运行"),
			]);
			const context = await fixture.application.contextForSession(session.id);
			const first = fixture.application.events.start(session.id, { text: "启动服务器", context: context.runtime });
			for await (const _entry of fixture.application.events.subscribe(first.runId)) {
				/* drain */
			}
			await vi.waitFor(async () => expect(await readFile(join(session.cwd, "port.txt"), "utf8")).toMatch(/^\d+$/u), {
				// A cold native sandbox can still be initializing after the tool has yielded.
				timeout: 15000,
			});
			const port = await readFile(join(session.cwd, "port.txt"), "utf8");
			const url = `http://127.0.0.1:${port}`;
			expect(await (await fetch(url)).text()).toBe("dev-server-alive");
			fixture.faux.setResponses([
				fauxAssistantMessage(
					fauxToolCall(
						profile === "minimal" ? "persistent_shell" : profile === "ptc" ? "run_code" : "read",
						profile === "minimal"
							? { command: "Get-Content ./other.txt" }
							: profile === "ptc"
								? { code: 'console.log((await tools.read({ path: "other.txt" })).content);' }
								: { path: "other.txt" },
					),
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("其他工具已运行"),
			]);
			const second = fixture.application.events.start(session.id, { text: "读取文件", context: context.runtime });
			for await (const _entry of fixture.application.events.subscribe(second.runId)) {
				/* drain */
			}
			expect((await fixture.application.repositories.agentRuns.get(second.runId))?.status).toBe("completed");
			expect(await (await fetch(url)).text()).toBe("dev-server-alive");
			await fixture.application.services.permissions.setMode(session.id, "ask");
			fixture.faux.setResponses([
				fauxAssistantMessage(
					fauxToolCall(
						tool,
						profile === "ptc"
							? { code: 'await tools.exec_command({ command: "Write-Output should-not-run" });' }
							: profile === "minimal"
								? { action: "exec", command: "Write-Output should-not-run" }
								: { command: "Write-Output should-not-run" },
					),
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("停止"),
			]);
			const pending = fixture.application.events.start(session.id, { text: "下一条命令", context: context.runtime });
			const drain = (async () => {
				for await (const _entry of fixture.application.events.subscribe(pending.runId)) {
					/* drain */
				}
			})();
			await vi.waitFor(async () =>
				expect((await fixture.application.repositories.approvals.listPending()).length).toBe(1),
			);
			expect((await fixture.request(`/sessions/${session.id}/abort`, { method: "POST" })).status).toBe(202);
			await drain;
			expect((await fixture.application.repositories.agentRuns.get(pending.runId))?.status).toBe("aborted");
			expect(await fixture.application.repositories.approvals.listPending()).toEqual([]);
			await expect(fetch(url, { signal: AbortSignal.timeout(1000) })).rejects.toThrow();
		} finally {
			await fixture.close();
		}
	}, 45_000);
}
