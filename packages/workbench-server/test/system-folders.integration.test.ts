import { execFile } from "node:child_process";
import { mkdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import type { AgentEvent } from "@earendil-works/workbench-runtime";
import { expect, test } from "vitest";
import { createAssistantFixture } from "./assistant-fixture.ts";

test.runIf(process.platform === "win32")(
	"Windows desktop context uses the OS folder location, including redirected drives",
	async () => {
		const powershell = process.env.SystemRoot
			? join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
			: "powershell.exe";
		const { stdout } = await promisify(execFile)(
			powershell,
			[
				"-NoLogo",
				"-NoProfile",
				"-NonInteractive",
				"-Command",
				"[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); [Environment]::GetFolderPath([Environment+SpecialFolder]::DesktopDirectory) | ConvertTo-Json -Compress",
			],
			{ encoding: "utf8", windowsHide: true, timeout: 10_000 },
		);
		const desktop: unknown = JSON.parse(stdout.trim());
		if (typeof desktop !== "string" || !desktop) throw new Error("Windows did not report a desktop folder");
		const fixture = await createAssistantFixture();
		try {
			const session = await fixture.application.createSession({ profileSlug: "standard" });
			const context = await fixture.application.contextForSession(session.id);
			expect(context.runtime.appendSystemPrompt?.join("\n")).toContain(desktop);
		} finally {
			await fixture.close();
		}
	},
	30_000,
);

test.each(["ask", "full-access"] as const)(
	"%s: a resumed Pi session writes to the resolved desktop and preserves path approval",
	async (mode) => {
		let desktopPath = "";
		const fixture = await createAssistantFixture(undefined, {
			systemFolders: { readDesktop: async () => ({ path: desktopPath, source: "windows-known-folder" }) },
		});
		try {
			desktopPath = join(fixture.root, "旧桌面");
			await mkdir(desktopPath);
			const session = await fixture.application.createSession({ profileSlug: "standard" });
			await fixture.application.services.permissions.setMode(session.id, mode);
			fixture.faux.setResponses([
				(context) => {
					expect(context.systemPrompt).toContain(desktopPath);
					return fauxAssistantMessage("已读取桌面位置");
				},
			]);
			const initial = fixture.application.events.start(session.id, {
				text: "确认本机桌面位置",
				context: (await fixture.application.contextForSession(session.id)).runtime,
			});
			const initialEvents: AgentEvent[] = [];
			for await (const entry of fixture.application.events.subscribe(initial.runId)) {
				if (entry.event.type !== "stream.reset") initialEvents.push(entry.event);
			}
			expect(initialEvents.some((event) => event.type === "run.completed")).toBe(true);
			await fixture.restart();
			const previousDesktop = desktopPath;
			desktopPath = join(fixture.root, "重定向桌面 中文");
			await mkdir(desktopPath);
			await fixture.application.services.settings.set("sandbox.policy", {
				mode: "workspace-write",
				networkAccess: false,
				writableRoots: [desktopPath],
			});
			const target = join(desktopPath, "桌面验证.txt");
			fixture.faux.setResponses([
				(context) => {
					expect(context.systemPrompt).toContain(desktopPath);
					expect(context.systemPrompt).not.toContain(previousDesktop);
					const resolved = context.systemPrompt?.match(/当前用户的实际桌面目录[^\n]*：([^\n]+)/u)?.[1];
					if (!resolved) throw new Error("No resolved desktop was supplied to Pi");
					return fauxAssistantMessage(
						fauxToolCall(
							"write",
							{ path: join(resolved, "桌面验证.txt"), content: "真实桌面写入" },
							{ id: "desktop-write" },
						),
						{ stopReason: "toolUse" },
					);
				},
				fauxAssistantMessage("桌面文件已创建"),
			]);
			const context = await fixture.application.contextForSession(session.id);
			expect(context.systemFolders.desktop.path).toBe(desktopPath);
			const { runId } = fixture.application.events.start(session.id, {
				text: "在桌面创建一个 .txt 文件",
				context: context.runtime,
			});
			const collected = (async () => {
				const events: AgentEvent[] = [];
				for await (const entry of fixture.application.events.subscribe(runId)) {
					if (entry.event.type !== "stream.reset") events.push(entry.event);
				}
				return events;
			})();
			if (mode === "ask") {
				await expect
					.poll(async () => (await fixture.application.repositories.approvals.listPending()).length)
					.toBe(1);
				const approval = (await fixture.application.repositories.approvals.listPending())[0];
				expect(approval.operation).toEqual({ path: target, operation: "write" });
				await expect(stat(target)).rejects.toMatchObject({ code: "ENOENT" });
				await fixture.application.services.permissions.resolve(approval.id, "approved");
			}
			const events = await collected;
			expect(events.some((event) => event.type === "run.completed")).toBe(true);
			expect(
				events.some(
					(event) =>
						event.type === "tool.completed" && event.data.toolCallId === "desktop-write" && !event.data.isError,
				),
			).toBe(true);
			expect(events.some((event) => event.type === "permission.requested")).toBe(mode === "ask");
			expect(await readFile(target, "utf8")).toBe("真实桌面写入");
			await expect(stat(join(previousDesktop, "桌面验证.txt"))).rejects.toMatchObject({ code: "ENOENT" });
			expect((await fixture.application.services.sessions.get(session.id)).runtimeSessionId).toBe(
				session.runtimeSessionId,
			);
		} finally {
			await fixture.close();
		}
	},
	30_000,
);

test("an unavailable desktop is visible in context and requires resolution instead of guessing a C drive path", async () => {
	const fixture = await createAssistantFixture(undefined, {
		systemFolders: { readDesktop: async () => ({ source: "unavailable", diagnostic: "桌面查询失败" }) },
	});
	try {
		const session = await fixture.application.createSession({});
		const context = await fixture.application.contextForSession(session.id);
		expect(context.systemFolders.desktop.path).toBeUndefined();
		expect(context.runtime.appendSystemPrompt?.join("\n")).toContain("不得猜测 C 盘");
	} finally {
		await fixture.close();
	}
});
