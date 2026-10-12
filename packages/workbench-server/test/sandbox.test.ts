import { mkdir, readFile, rename, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { expect, test, vi } from "vitest";
import { createAssistantFixture } from "./assistant-fixture.ts";

test.each(["powershell", "verify_changes", "exec_command", "persistent_shell"])(
	"%s cannot bypass the workspace sandbox with full approval access",
	async (tool) => {
		const fixture = await createAssistantFixture();
		try {
			const session = await fixture.application.createSession({
				profileSlug: tool === "persistent_shell" ? "minimal" : "standard",
			});
			await fixture.application.services.permissions.setMode(session.id, "full-access");
			const outside = join(fixture.root, "outside.txt").replaceAll("'", "''");
			fixture.faux.setResponses([
				fauxAssistantMessage(
					fauxToolCall(tool, {
						command: `Set-Content -LiteralPath '${outside}' -Value escaped`,
						...(tool === "exec_command" ? { yield_time_ms: 10000 } : {}),
						...(tool === "persistent_shell" ? { timeout: 10 } : {}),
					}),
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("已处理"),
			]);
			const run = fixture.application.events.start(session.id, { text: "创建文件" });
			const completed: string[] = [];
			for await (const { event } of fixture.application.events.subscribe(run.runId))
				if (event.type === "tool.completed") completed.push(event.data.toolName);
			expect(completed).toContain(tool);
			await expect(readFile(join(fixture.root, "outside.txt"))).rejects.toMatchObject({ code: "ENOENT" });
			expect(await (await fixture.request("/approvals")).json()).toEqual([]);
		} finally {
			await fixture.close();
		}
	},
	30_000,
);

test("file tools, PTC and resumed sessions enforce saved sandbox settings", async () => {
	const fixture = await createAssistantFixture();
	try {
		const outside = join(fixture.root, "outside.txt");
		let standardSessionId = "";
		for (const profileSlug of ["standard", "ptc"]) {
			const session = await fixture.application.createSession({ profileSlug });
			if (profileSlug === "standard") standardSessionId = session.id;
			await fixture.application.services.permissions.setMode(session.id, "full-access");
			const input = { path: outside, content: "escaped" };
			fixture.faux.setResponses([
				fauxAssistantMessage(
					profileSlug === "ptc"
						? fauxToolCall("run_code", { code: `await tools.write(${JSON.stringify(input)});` })
						: fauxToolCall("write", input),
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("已处理"),
			]);
			const run = fixture.application.events.start(session.id, { text: "创建文件" });
			for await (const _event of fixture.application.events.subscribe(run.runId)) {
			}
			await expect(readFile(outside)).rejects.toMatchObject({ code: "ENOENT" });
		}
		await fixture.application.services.settings.set("sandbox.policy", {
			mode: "read-only",
			networkAccess: false,
			writableRoots: [],
		});
		await fixture.restart();
		const session = await fixture.application.services.sessions.get(standardSessionId);
		let readonlyError = "";
		fixture.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("write", { path: "readonly.txt", content: "escaped" }), {
				stopReason: "toolUse",
			}),
			(context) => {
				expect(context.systemPrompt).toContain('"mode":"read-only"');
				const result = context.messages.at(-1);
				if (result?.role === "toolResult" && result.isError) readonlyError = JSON.stringify(result.content);
				return fauxAssistantMessage("已处理");
			},
		]);
		const run = fixture.application.events.start(session.id, { text: "检查沙箱" });
		for await (const _event of fixture.application.events.subscribe(run.runId)) {
		}
		await expect(readFile(join(session.cwd, "readonly.txt"))).rejects.toMatchObject({ code: "ENOENT" });
		expect(readonlyError).toContain("当前沙箱为只读");
		expect((await fixture.application.contextForSession(session.id)).runtime.sandbox?.mode).toBe("read-only");
	} finally {
		await fixture.close();
	}
}, 30_000);

test("a replaced writable directory is rejected before resuming a session", async () => {
	const fixture = await createAssistantFixture();
	try {
		const extra = join(fixture.root, "allowed");
		const outside = join(fixture.root, "unapproved");
		await mkdir(extra);
		await mkdir(outside);
		await fixture.application.services.settings.set("sandbox.policy", {
			mode: "workspace-write",
			networkAccess: false,
			writableRoots: [extra],
		});
		const session = await fixture.application.createSession({ profileSlug: "standard" });
		await rename(extra, join(fixture.root, "original"));
		await symlink(outside, extra, process.platform === "win32" ? "junction" : "dir");
		await expect(fixture.application.contextForSession(session.id)).rejects.toThrow("额外可写目录已变化");
	} finally {
		await fixture.close();
	}
});

test("changing sandbox settings closes old processes and rejects their terminal handles", async () => {
	const fixture = await createAssistantFixture();
	try {
		const session = await fixture.application.createSession({ profileSlug: "standard" });
		await fixture.application.services.permissions.setMode(session.id, "full-access");
		await writeFile(
			join(session.cwd, "server.cjs"),
			'const s = require("node:http").createServer((q,r) => r.end("alive")); s.listen(0, "127.0.0.1", () => require("node:fs").writeFileSync("port.txt", String(s.address().port)));',
		);
		let terminalId = "";
		fixture.faux.setResponses([
			fauxAssistantMessage(
				fauxToolCall("exec_command", {
					command: `& '${process.execPath.replaceAll("'", "''")}' server.cjs`,
					yield_time_ms: 0,
				}),
				{ stopReason: "toolUse" },
			),
			(context) => {
				expect(context.systemPrompt).toContain('"mode":"workspace-write"');
				const result = context.messages.at(-1);
				const details: unknown = result?.role === "toolResult" ? result.details : undefined;
				if (
					typeof details === "object" &&
					details !== null &&
					"session_id" in details &&
					typeof details.session_id === "string"
				)
					terminalId = details.session_id;
				return fauxAssistantMessage("服务器已启动");
			},
		]);
		const first = fixture.application.events.start(session.id, { text: "启动服务器" });
		for await (const _event of fixture.application.events.subscribe(first.runId)) {
		}
		expect(terminalId).not.toBe("");
		await vi.waitFor(async () => expect(await readFile(join(session.cwd, "port.txt"), "utf8")).toMatch(/^\d+$/u), {
			timeout: 8000,
		});
		const url = `http://127.0.0.1:${await readFile(join(session.cwd, "port.txt"), "utf8")}`;
		expect(await (await fetch(url)).text()).toBe("alive");
		await fixture.application.services.settings.set("sandbox.policy", {
			mode: "read-only",
			networkAccess: false,
			writableRoots: [],
		});
		let expiredHandle = "";
		fixture.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("write_stdin", { session_id: terminalId, chars: "", yield_time_ms: 0 }), {
				stopReason: "toolUse",
			}),
			(context) => {
				expect(context.systemPrompt).toContain('"mode":"read-only"');
				const result = context.messages.at(-1);
				if (result?.role === "toolResult" && result.isError) expiredHandle = JSON.stringify(result.content);
				return fauxAssistantMessage("设置已生效");
			},
		]);
		const second = fixture.application.events.start(session.id, { text: "继续读取旧终端" });
		for await (const _event of fixture.application.events.subscribe(second.runId)) {
		}
		expect(expiredHandle).toContain("终端会话不存在");
		await expect(fetch(url, { signal: AbortSignal.timeout(1000) })).rejects.toThrow();
	} finally {
		await fixture.close();
	}
}, 30_000);

test("sandbox settings reject invalid boundaries and allow an explicitly added directory", async () => {
	const fixture = await createAssistantFixture();
	try {
		for (const value of [
			{ mode: "bogus" },
			{ mode: ["workspace-write"], networkAccess: false, writableRoots: [] },
			{ mode: "workspace-write", networkAccess: false, writableRoots: ["relative"] },
			{ mode: "workspace-write", networkAccess: false, writableRoots: [], protectedPaths: [] },
		]) {
			const response = await fixture.request("/settings/sandbox.policy", {
				method: "PUT",
				body: JSON.stringify({ value }),
			});
			expect(response.status).toBe(400);
		}
		const extra = join(fixture.root, "allowed");
		await mkdir(extra);
		await writeFile(join(extra, "existing.txt"), "before");
		await fixture.application.services.settings.set("sandbox.policy", {
			mode: "workspace-write",
			networkAccess: false,
			writableRoots: [extra],
		});
		const session = await fixture.application.createSession({ profileSlug: "standard" });
		await fixture.application.services.permissions.setMode(session.id, "full-access");
		fixture.faux.setResponses([
			fauxAssistantMessage(
				fauxToolCall("powershell", {
					command: `Set-Content -LiteralPath '${join(extra, "existing.txt").replaceAll("'", "''")}' -Value after`,
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("已处理"),
		]);
		const run = fixture.application.events.start(session.id, { text: "更新授权目录" });
		for await (const _event of fixture.application.events.subscribe(run.runId)) {
		}
		expect(await readFile(join(extra, "existing.txt"), "utf8")).toContain("after");
	} finally {
		await fixture.close();
	}
}, 30_000);

test("file tools protect Windows control-directory casing and directory junctions", async () => {
	const fixture = await createAssistantFixture();
	try {
		const session = await fixture.application.createSession({ profileSlug: "standard" });
		await fixture.application.services.permissions.setMode(session.id, "full-access");
		await mkdir(join(session.cwd, ".git"));
		await writeFile(join(session.cwd, ".git", "config.txt"), "unchanged");
		await symlink(fixture.root, join(session.cwd, "outside-link"), process.platform === "win32" ? "junction" : "dir");
		for (const path of [
			process.platform === "win32" ? ".GIT/config.txt" : ".git/config.txt",
			"outside-link/escaped.txt",
		]) {
			fixture.faux.setResponses([
				fauxAssistantMessage(fauxToolCall("write", { path, content: "escaped" }), { stopReason: "toolUse" }),
				fauxAssistantMessage("已处理"),
			]);
			const run = fixture.application.events.start(session.id, { text: "检查文件边界" });
			for await (const _event of fixture.application.events.subscribe(run.runId)) {
			}
		}
		expect(await readFile(join(session.cwd, ".git", "config.txt"), "utf8")).toBe("unchanged");
		await expect(readFile(join(fixture.root, "escaped.txt"))).rejects.toMatchObject({ code: "ENOENT" });
	} finally {
		await fixture.close();
	}
});
