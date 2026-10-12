import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import type { PermissionMode } from "@earendil-works/workbench-core/contracts";
import type { AgentEvent } from "@earendil-works/workbench-runtime";
import { expect, test } from "vitest";
import { createAssistantFixture } from "./assistant-fixture.ts";

test("permission API validates modes, isolates sessions and restores the saved mode after restart", async () => {
	const fixture = await createAssistantFixture();
	try {
		const one = await fixture.application.createSession({});
		const two = await fixture.application.createSession({});
		expect(await (await fixture.request(`/sessions/${one.id}/permission-mode`)).json()).toEqual({ mode: "ask" });
		expect(
			(
				await fixture.request(`/sessions/${one.id}/permission-mode`, {
					method: "PUT",
					body: JSON.stringify({ mode: "invalid" }),
				})
			).status,
		).toBe(400);
		const saved = await fixture.request(`/sessions/${one.id}/permission-mode`, {
			method: "PUT",
			body: JSON.stringify({ mode: "auto" }),
		});
		expect(saved.status, await saved.text()).toBe(200);
		const permissions = fixture.application.services.permissions;
		expect(await permissions.requiresApproval(one.id, "mcp", true)).toBe(false);
		expect(await permissions.requiresApproval(one.id, "mcp", false)).toBe(true);
		expect(await permissions.requiresApproval(one.id, "shell")).toBe(true);
		expect(await permissions.requiresApproval(one.id, "external-path")).toBe(true);
		expect(await permissions.requiresApproval(two.id, "mcp", true)).toBe(true);
		await fixture.restart();
		expect(await (await fixture.request(`/sessions/${one.id}/permission-mode`)).json()).toEqual({ mode: "auto" });
		expect(await (await fixture.request(`/sessions/${two.id}/permission-mode`)).json()).toEqual({ mode: "ask" });
		expect(
			(
				await fetch(`${fixture.address.origin}/api/v1/sessions/${one.id}/permission-mode`, {
					method: "PUT",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ mode: "full-access" }),
				})
			).status,
		).toBe(403);
	} finally {
		await fixture.close();
	}
});

test("full access executes real Pi file and PowerShell tools but retains protected file boundaries", async () => {
	const fixture = await createAssistantFixture();
	try {
		const external = join(fixture.root, "outside.txt");
		const credential = join(fixture.root, "pi-agent", "private.txt");
		await writeFile(external, "外部资料");
		await writeFile(credential, "protected-test-value");
		const session = await fixture.application.createSession({ profileSlug: "standard" });
		await fixture.application.services.permissions.setMode(session.id, "full-access");
		fixture.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("read", { path: external }, { id: "read-external" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage(
				fauxToolCall("powershell", { command: 'Write-Output "permission-mode-ok"' }, { id: "shell" }),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(fauxToolCall("read", { path: credential }, { id: "read-secret" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage(
				fauxToolCall(
					"write",
					{ path: join(fixture.application.paths.workspace, "MEMORY.md"), content: "未经确认的记忆" },
					{ id: "write-memory" },
				),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("权限测试完成"),
		]);
		const context = await fixture.application.contextForSession(session.id);
		const { runId } = fixture.application.events.start(session.id, { text: "验证权限", context: context.runtime });
		const events: AgentEvent[] = [];
		for await (const entry of fixture.application.events.subscribe(runId))
			if (entry.event.type !== "stream.reset") events.push(entry.event);
		expect(events.some((event) => event.type === "permission.requested")).toBe(false);
		const completed = events.filter((event) => event.type === "tool.completed");
		expect(completed.find((event) => event.data.toolCallId === "read-external")?.data.isError).toBe(false);
		expect(completed.find((event) => event.data.toolCallId === "shell")?.data.isError).toBe(false);
		expect(completed.find((event) => event.data.toolCallId === "read-secret")?.data.isError).toBe(true);
		expect(completed.find((event) => event.data.toolCallId === "write-memory")?.data.isError).toBe(true);
		expect(JSON.stringify(events)).not.toContain("protected-test-value");
		expect(events.some((event) => event.type === "run.completed")).toBe(true);
	} finally {
		await fixture.close();
	}
}, 30_000);

test("switching to auto keeps shell approval pending, and Stop cancels it", async () => {
	const fixture = await createAssistantFixture();
	try {
		const session = await fixture.application.createSession({ profileSlug: "standard" });
		fixture.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("powershell", { command: "Write-Output waiting" }, { id: "shell-ask" }), {
				stopReason: "toolUse",
			}),
		]);
		const context = await fixture.application.contextForSession(session.id);
		const { runId } = fixture.application.events.start(session.id, { text: "等待批准", context: context.runtime });
		const collected = (async () => {
			for await (const _entry of fixture.application.events.subscribe(runId)) {
				/* Drain the real runtime stream. */
			}
		})();
		await expect.poll(async () => (await fixture.application.repositories.approvals.listPending()).length).toBe(1);
		expect(await (await fixture.request(`/sessions/${session.id}/runtime-state`)).json()).toMatchObject({
			activeRunId: runId,
			development: { runId, plan: [], checks: [], changedFiles: [] },
		});
		expect(
			(
				await fixture.request(`/sessions/${session.id}/permission-mode`, {
					method: "PUT",
					body: JSON.stringify({ mode: "auto" }),
				})
			).status,
		).toBe(200);
		expect(await fixture.application.repositories.approvals.listPending()).toHaveLength(1);
		expect((await fixture.request(`/sessions/${session.id}/abort`, { method: "POST" })).status).toBe(202);
		await collected;
		expect(await fixture.application.repositories.approvals.listPending()).toHaveLength(0);
		expect(await fixture.application.services.permissions.getMode(session.id)).toBe("auto");
	} finally {
		await fixture.close();
	}
}, 30_000);

test.each<PermissionMode>(["ask", "auto", "full-access"])(
	"%s enforces project approval boundaries when the command sandbox is disabled",
	async (mode) => {
		const fixture = await createAssistantFixture();
		try {
			await fixture.application.services.settings.set("sandbox.policy", {
				mode: "danger-full-access",
				networkAccess: true,
				writableRoots: [],
			});
			const source = join(fixture.root, "project-source");
			await mkdir(source);
			const outside = join(fixture.application.paths.workspace, "outside-project.txt");
			await writeFile(outside, "outside data");
			await writeFile(join(source, ".env"), "api_key=hidden-test-value");
			const project = await fixture.application.createProject({ sourcePath: source });
			const session = await fixture.application.createSession({ projectId: project.id });
			await fixture.application.services.permissions.setMode(session.id, mode);
			fixture.faux.setResponses([
				fauxAssistantMessage(fauxToolCall("write", { path: "inside.txt", content: "inside" }, { id: "inside" }), {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage(fauxToolCall("read", { path: outside }, { id: "outside-read" }), {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage(
					fauxToolCall("write", { path: outside, content: "changed" }, { id: "outside-write" }),
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage(fauxToolCall("read", { path: ".env" }, { id: "credential-read" }), {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("完成"),
			]);
			const { runId } = fixture.application.events.start(session.id, {
				text: "验证项目边界",
				context: (await fixture.application.contextForSession(session.id)).runtime,
			});
			const eventsPromise = (async () => {
				const events: AgentEvent[] = [];
				for await (const entry of fixture.application.events.subscribe(runId))
					if (entry.event.type !== "stream.reset") events.push(entry.event);
				return events;
			})();
			if (mode !== "full-access") {
				for (const toolCallId of ["outside-read", "outside-write"]) {
					await expect
						.poll(
							async () =>
								(await fixture.application.repositories.approvals.listPending()).find(
									(item) => item.toolCallId === toolCallId,
								)?.id,
						)
						.toBeTypeOf("string");
					const approval = (await fixture.application.repositories.approvals.listPending()).find(
						(item) => item.toolCallId === toolCallId,
					)!;
					await fixture.application.services.permissions.resolve(approval.id, "approved");
				}
			}
			const events = await eventsPromise;
			const completed = events.filter(
				(event): event is Extract<AgentEvent, { type: "tool.completed" }> => event.type === "tool.completed",
			);
			expect(events.filter((event) => event.type === "permission.requested")).toHaveLength(
				mode === "full-access" ? 0 : 2,
			);
			expect(completed.find((event) => event.data.toolCallId === "credential-read")?.data.isError).toBe(true);
			expect(await readFile(join(source, "inside.txt"), "utf8")).toBe("inside");
			expect(await readFile(outside, "utf8")).toBe("changed");
			expect(JSON.stringify(events)).not.toContain("hidden-test-value");
		} finally {
			await fixture.close();
		}
	},
	30_000,
);

test("changing to full access releases the waiting tool and applies to the next tool call", async () => {
	const fixture = await createAssistantFixture();
	try {
		const session = await fixture.application.createSession({ profileSlug: "standard" });
		fixture.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("powershell", { command: "Write-Output first" }, { id: "first-shell" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage(fauxToolCall("powershell", { command: "Write-Output second" }, { id: "second-shell" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("完成"),
		]);
		const { runId } = fixture.application.events.start(session.id, {
			text: "验证热切换",
			context: (await fixture.application.contextForSession(session.id)).runtime,
		});
		const eventsPromise = (async () => {
			const events: AgentEvent[] = [];
			for await (const entry of fixture.application.events.subscribe(runId))
				if (entry.event.type !== "stream.reset") events.push(entry.event);
			return events;
		})();
		await expect.poll(async () => (await fixture.application.repositories.approvals.listPending()).length).toBe(1);
		expect(
			(
				await fixture.request(`/sessions/${session.id}/permission-mode`, {
					method: "PUT",
					body: JSON.stringify({ mode: "full-access" }),
				})
			).status,
		).toBe(200);
		await expect.poll(async () => (await fixture.application.repositories.approvals.listPending()).length).toBe(0);
		const events = await eventsPromise;
		const completed = events.filter(
			(event): event is Extract<AgentEvent, { type: "tool.completed" }> => event.type === "tool.completed",
		);
		expect(events.filter((event) => event.type === "permission.requested")).toHaveLength(1);
		expect(completed.filter((event) => !event.data.isError)).toHaveLength(2);
	} finally {
		await fixture.close();
	}
}, 30_000);

test("tightening permissions during a run requires approval for the next shell command", async () => {
	const fixture = await createAssistantFixture();
	try {
		const session = await fixture.application.createSession({ profileSlug: "standard" });
		await fixture.application.services.permissions.setMode(session.id, "full-access");
		fixture.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("powershell", { command: "Set-Content first-approved.txt first" }), {
				stopReason: "toolUse",
			}),
			async () => {
				await fixture.application.services.permissions.setMode(session.id, "ask");
				return fauxAssistantMessage(
					fauxToolCall(
						"powershell",
						{ command: "Set-Content second-approved.txt second" },
						{ id: "tightened-shell" },
					),
					{ stopReason: "toolUse" },
				);
			},
			fauxAssistantMessage("完成"),
		]);
		const { runId } = fixture.application.events.start(session.id, {
			text: "验证收紧权限",
			context: (await fixture.application.contextForSession(session.id)).runtime,
		});
		const collected = (async () => {
			const events: AgentEvent[] = [];
			for await (const entry of fixture.application.events.subscribe(runId))
				if (entry.event.type !== "stream.reset") events.push(entry.event);
			return events;
		})();
		await expect
			.poll(async () => (await fixture.application.repositories.approvals.listPending()).length, { timeout: 10_000 })
			.toBe(1);
		expect(await readFile(join(session.cwd, "first-approved.txt"), "utf8")).toContain("first");
		await expect(readFile(join(session.cwd, "second-approved.txt"))).rejects.toMatchObject({
			code: "ENOENT",
		});
		const pending = (await fixture.application.repositories.approvals.listPending())[0];
		expect(pending.toolCallId).toBe("tightened-shell");
		await fixture.application.services.permissions.resolve(pending.id, "approved");
		const events = await collected;
		expect(events.filter((event) => event.type === "permission.requested")).toHaveLength(1);
		expect(await readFile(join(session.cwd, "second-approved.txt"), "utf8")).toContain("second");
		expect(await fixture.application.services.permissions.getMode(session.id)).toBe("ask");
	} finally {
		await fixture.close();
	}
}, 30_000);

test.each<{ mode: PermissionMode; binding: "ask" | "allow" }>([
	{ mode: "auto", binding: "allow" },
	{ mode: "full-access", binding: "ask" },
])(
	"switching to $mode releases a waiting PTC MCP call and applies within the same program",
	async ({ mode, binding }) => {
		const fixture = await createAssistantFixture();
		try {
			const app = fixture.application;
			const connection = await app.services.connections.create({
				name: "PTC 权限测试",
				transport: "stdio",
				authKind: "none",
				stdio: {
					command: process.execPath,
					args: [fileURLToPath(new URL("../../workbench-mcp/test/fixtures/stdio-server.mjs", import.meta.url))],
					environmentKeys: [],
				},
			});
			const echo = (await app.services.connections.test(connection.id)).tools.find((tool) => tool.name === "echo")!;
			const profile = await app.services.profiles.create({
				name: "PTC MCP 助手",
				systemPrompt: "使用程序调用指定 MCP 工具",
				tools: ["run_code"],
				mcpBindings: [
					{
						connectionId: connection.id,
						toolName: echo.name,
						approvedDefinitionHash: echo.definitionHash,
						approval: binding,
					},
				],
			});
			const session = await app.createSession({ profileId: profile.id });
			const toolName = (await app.services.capabilities.resolveForSession(profile)).toolBindings[0].descriptor.name;
			fixture.faux.setResponses([
				fauxAssistantMessage(
					fauxToolCall("run_code", {
						code: `const first = await tools[${JSON.stringify(toolName)}]({ text: "first-echo" }); console.log(first.content); const second = await tools[${JSON.stringify(toolName)}]({ text: "second-echo" }); console.log(second.content);`,
					}),
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("完成"),
			]);
			const { runId } = app.events.start(session.id, {
				text: "验证嵌套审批",
				context: (await app.contextForSession(session.id)).runtime,
			});
			const collected = (async () => {
				const events: AgentEvent[] = [];
				for await (const entry of app.events.subscribe(runId))
					if (entry.event.type !== "stream.reset") events.push(entry.event);
				return events;
			})();
			await expect.poll(async () => (await app.repositories.approvals.listPending()).length).toBe(1);
			expect(
				(
					await fixture.request(`/sessions/${session.id}/permission-mode`, {
						method: "PUT",
						body: JSON.stringify({ mode }),
					})
				).status,
			).toBe(200);
			const events = await collected;
			expect(
				events.filter(
					(event) =>
						event.type === "tool.updated" &&
						event.data.toolName === toolName &&
						JSON.stringify(event.data.update).includes('"status":"pending"'),
				),
			).toHaveLength(1);
			const nested = events.filter((event) => event.type === "tool.completed" && event.data.toolName === toolName);
			expect(nested).toHaveLength(2);
			expect(nested.every((event) => event.type === "tool.completed" && !event.data.isError)).toBe(true);
			expect(JSON.stringify(nested)).toContain("second-echo");
			expect(await app.repositories.approvals.listPending()).toEqual([]);
		} finally {
			await fixture.close();
		}
	},
	30_000,
);

test.each<{ mode: PermissionMode; binding: "ask" | "allow"; asks: boolean }>([
	{ mode: "ask", binding: "allow", asks: true },
	{ mode: "auto", binding: "allow", asks: false },
	{ mode: "auto", binding: "ask", asks: true },
	{ mode: "full-access", binding: "ask", asks: false },
])(
	"$mode with MCP binding $binding enforces approval through real Pi and MCP",
	async ({ mode, binding, asks }) => {
		const fixture = await createAssistantFixture();
		try {
			const app = fixture.application;
			const connection = await app.services.connections.create({
				name: "权限协议测试",
				transport: "stdio",
				authKind: "none",
				stdio: {
					command: process.execPath,
					args: [fileURLToPath(new URL("../../workbench-mcp/test/fixtures/stdio-server.mjs", import.meta.url))],
					environmentKeys: [],
				},
			});
			const catalog = await app.services.connections.test(connection.id);
			const echo = catalog.tools.find((tool) => tool.name === "echo")!;
			const profile = await app.services.profiles.create({
				name: "权限助手",
				systemPrompt: "使用指定工具",
				tools: [],
				skillIds: [],
				mcpBindings: [
					{
						connectionId: connection.id,
						toolName: echo.name,
						approvedDefinitionHash: echo.definitionHash,
						approval: binding,
					},
				],
			});
			const session = await app.createSession({ profileId: profile.id });
			await app.services.permissions.setMode(session.id, mode);
			const toolName = (await app.services.capabilities.resolveForSession(profile)).toolBindings[0].descriptor.name;
			fixture.faux.setResponses([
				fauxAssistantMessage(fauxToolCall(toolName, { text: "真实 MCP 调用" }, { id: "mcp-permission" }), {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("调用完成"),
			]);
			const { runId } = app.events.start(session.id, {
				text: "验证权限",
				context: (await app.contextForSession(session.id)).runtime,
			});
			const collected = (async () => {
				const events: AgentEvent[] = [];
				for await (const entry of app.events.subscribe(runId))
					if (entry.event.type !== "stream.reset") events.push(entry.event);
				return events;
			})();
			if (asks) {
				await expect.poll(async () => (await app.repositories.approvals.listPending()).length).toBe(1);
				await app.services.permissions.resolve((await app.repositories.approvals.listPending())[0].id, "approved");
			}
			const events = await collected;
			expect(events.some((event) => event.type === "tool.completed" && !event.data.isError)).toBe(true);
			expect(events.some((event) => event.type === "run.completed")).toBe(true);
			expect(await app.repositories.approvals.listPending()).toHaveLength(0);
			expect(
				events.some(
					(event) =>
						event.type === "tool.updated" && JSON.stringify(event.data.update).includes('"status":"pending"'),
				),
			).toBe(asks);
		} finally {
			await fixture.close();
		}
	},
	30_000,
);
