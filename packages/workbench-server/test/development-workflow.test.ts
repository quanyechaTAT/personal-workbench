import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import {
	DEVELOPMENT_WORKFLOW,
	LEGACY_CODING_SKILL,
	PREVIOUS_DEVELOPMENT_WORKFLOW,
} from "@earendil-works/workbench-core";
import { type DevelopmentState, isDevelopmentState } from "@earendil-works/workbench-runtime";
import { expect, test } from "vitest";
import { createAssistantFixture } from "./assistant-fixture.ts";

test.each(["first-check", "last-check", "invented-check"])(
	"acceptance only accepts the latest actual check ID (%s)",
	async (checkId) => {
		const fixture = await createAssistantFixture();
		try {
			const session = await fixture.application.createSession({ profileSlug: "standard" });
			await fixture.application.services.permissions.setMode(session.id, "full-access");
			const command = "if ((Get-Content feature.txt) -ne 'implemented') { exit 1 }; exit 0";
			fixture.faux.setResponses([
				fauxAssistantMessage(fauxToolCall("write", { path: "feature.txt", content: "implemented" }), {
					stopReason: "toolUse",
				}),
				...["first-check", "last-check"].map((id) =>
					fauxAssistantMessage(fauxToolCall("verify_changes", { command }, { id }), { stopReason: "toolUse" }),
				),
				fauxAssistantMessage(
					fauxToolCall("accept_changes", {
						criteria: [{ requirement: "实现功能文件", checkIds: [checkId], evidence: "实际文件内容匹配" }],
					}),
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("本轮结束"),
			]);
			const run = fixture.application.events.start(session.id, { text: "实现并验收" });
			let rejected = false;
			for await (const entry of fixture.application.events.subscribe(run.runId))
				if (entry.event.type === "tool.completed" && entry.event.data.toolName === "accept_changes")
					rejected = entry.event.data.isError;
			expect(rejected).toBe(checkId !== "last-check");
			const state = await readDevelopmentState(await fixture.request(`/sessions/${session.id}/runtime-state`));
			expect(state.acceptance.status).toBe(checkId === "last-check" ? "accepted" : "needs_review");
		} finally {
			await fixture.close();
		}
	},
);

test.each([false, true])("a development task requires acceptance before user review (accepted: %s)", async (accept) => {
	const fixture = await createAssistantFixture();
	try {
		const task = await fixture.application.services.tasks.create({ title: "实现功能并验证" });
		fixture.faux.setResponses([
			async (context) => {
				const [session] = await fixture.application.services.sessions.list();
				await fixture.application.services.permissions.setMode(session.id, "full-access");
				expect(context.systemPrompt).toContain("accept_changes");
				return fauxAssistantMessage(fauxToolCall("write", { path: "task-feature.txt", content: "implemented" }), {
					stopReason: "toolUse",
				});
			},
			...(accept
				? [
						fauxAssistantMessage(
							fauxToolCall(
								"verify_changes",
								{
									command: "if ((Get-Content task-feature.txt) -ne 'implemented') { exit 1 }; exit 0",
								},
								{ id: "task-check" },
							),
							{ stopReason: "toolUse" },
						),
						fauxAssistantMessage(
							fauxToolCall("accept_changes", {
								criteria: [
									{
										requirement: "功能文件包含实现",
										checkIds: ["task-check"],
										evidence: "实际文件内容匹配",
									},
								],
							}),
							{ stopReason: "toolUse" },
						),
					]
				: []),
			fauxAssistantMessage("功能已完成"),
		]);
		const run = await fixture.application.startTask(task.id, {
			profileSlug: "standard",
			expectedVersion: task.version,
		});
		for await (const _entry of fixture.application.events.subscribe(run.runId)) {
		}
		expect(await fixture.application.services.tasks.get(task.id)).toMatchObject({
			status: accept ? "review" : "blocked",
			completedAt: undefined,
		});
		expect(await fixture.application.services.tasks.listRuns(task.id)).toMatchObject([
			{
				status: "review",
				errorCode: accept ? undefined : "verification_required",
			},
		]);
		await fixture.restart();
		expect((await fixture.application.services.tasks.get(task.id)).status).toBe(accept ? "review" : "blocked");
	} finally {
		await fixture.close();
	}
});

test.each(["standard", "ptc"])("%s cannot bypass acceptance by completing a task directly", async (profileSlug) => {
	const fixture = await createAssistantFixture();
	try {
		const task = await fixture.application.services.tasks.create({ title: "待验收任务", type: "agent" });
		const session = await fixture.application.createSession({ profileSlug });
		await fixture.application.services.permissions.setMode(session.id, "full-access");
		const input = { id: task.id, status: "done", expectedVersion: task.version };
		fixture.faux.setResponses(
			profileSlug === "ptc"
				? [
						fauxAssistantMessage(
							fauxToolCall("run_code", {
								code: `await tools.write({ path: "unchecked.txt", content: "changed" }); await tools.task_update(${JSON.stringify(input)});`,
							}),
							{ stopReason: "toolUse" },
						),
						fauxAssistantMessage("完成"),
					]
				: [
						fauxAssistantMessage(fauxToolCall("write", { path: "unchecked.txt", content: "changed" }), {
							stopReason: "toolUse",
						}),
						fauxAssistantMessage(fauxToolCall("task_update", input), { stopReason: "toolUse" }),
						fauxAssistantMessage("完成"),
					],
		);
		const context = await fixture.application.contextForSession(session.id);
		const run = fixture.application.events.start(session.id, {
			text: "实现功能并完成任务",
			context: context.runtime,
		});
		let rejected = false;
		for await (const entry of fixture.application.events.subscribe(run.runId))
			if (entry.event.type === "tool.completed" && entry.event.data.toolName === "task_update")
				rejected = entry.event.data.isError;
		expect(rejected).toBe(true);
		expect((await fixture.application.services.tasks.get(task.id)).status).toBe("todo");
	} finally {
		await fixture.close();
	}
});

test("previous stock assistants gain acceptance without changing user-edited assistants", async () => {
	const fixture = await createAssistantFixture();
	try {
		const stock = await fixture.application.services.profiles.getBySlug("standard");
		const previous = {
			...stock,
			tools: stock.tools.filter((tool) => tool !== "accept_changes"),
			systemPrompt: stock.systemPrompt.replace(DEVELOPMENT_WORKFLOW, PREVIOUS_DEVELOPMENT_WORKFLOW),
			version: stock.version + 1,
		};
		await fixture.application.repositories.profiles.upsert(previous, stock.version);
		const custom = await fixture.application.services.profiles.create({
			name: "自定义开发助手",
			systemPrompt: "用户维护的指令",
			tools: ["read", "verify_changes"],
		});
		await fixture.restart();
		expect(await fixture.application.services.profiles.get(stock.id)).toMatchObject({
			id: stock.id,
			tools: expect.arrayContaining(["accept_changes"]),
			systemPrompt: expect.stringContaining(DEVELOPMENT_WORKFLOW),
			version: previous.version + 1,
		});
		expect(await fixture.application.services.profiles.get(custom.id)).toMatchObject(custom);
		const upgraded = await fixture.application.services.profiles.get(stock.id);
		await fixture.restart();
		expect(await fixture.application.services.profiles.get(stock.id)).toEqual(upgraded);
	} finally {
		await fixture.close();
	}
});

test.each([
	{ name: "passed commands without acceptance", extra: [], accept: false, expected: "needs_review" },
	{ name: "passed checks and requirement coverage", extra: [], accept: true, expected: "accepted" },
	{
		name: "a later failed check",
		extra: [
			fauxAssistantMessage(fauxToolCall("verify_changes", { command: "exit 9" }, { id: "failed-check" }), {
				stopReason: "toolUse",
			}),
		],
		accept: true,
		expected: "needs_verification",
	},
	{
		name: "an unfinished plan",
		extra: [
			fauxAssistantMessage(
				fauxToolCall("update_plan", { plan: [{ step: "Check another requirement", status: "pending" }] }),
				{ stopReason: "toolUse" },
			),
		],
		accept: true,
		expected: "needs_review",
	},
])("functional acceptance distinguishes $name", async ({ extra, accept, expected }) => {
	const fixture = await createAssistantFixture();
	try {
		const session = await fixture.application.createSession({ profileSlug: "standard" });
		await fixture.application.services.permissions.setMode(session.id, "full-access");
		fixture.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("write", { path: "feature.txt", content: "implemented" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage(
				fauxToolCall(
					"verify_changes",
					{
						command:
							"if ((Get-Content feature.txt) -ne 'implemented') { exit 1 }; Write-Output verified-feature; exit 0",
					},
					{ id: "feature-check" },
				),
				{ stopReason: "toolUse" },
			),
			...extra,
			...(accept
				? [
						fauxAssistantMessage(
							fauxToolCall("accept_changes", {
								criteria: [
									{
										requirement: "Feature file contains the implementation",
										checkIds: ["feature-check"],
										evidence: "Read the actual file and checked its content",
									},
								],
							}),
							{ stopReason: "toolUse" },
						),
					]
				: []),
			fauxAssistantMessage("本轮结束"),
		]);
		const run = fixture.application.events.start(session.id, { text: "实现功能并验收" });
		for await (const _entry of fixture.application.events.subscribe(run.runId)) {
		}
		const state = await readDevelopmentState(await fixture.request(`/sessions/${session.id}/runtime-state`));
		expect(state.acceptance.status).toBe(expected);
		await fixture.restart();
		expect(
			(await readDevelopmentState(await fixture.request(`/sessions/${session.id}/runtime-state`))).acceptance,
		).toEqual(state.acceptance);
	} finally {
		await fixture.close();
	}
});

test.each(["write", "exec_command", "update_plan"] as const)(
	"%s after accepted work invalidates both checks and acceptance",
	async (tool) => {
		const fixture = await createAssistantFixture();
		try {
			const session = await fixture.application.createSession({ profileSlug: "standard" });
			await fixture.application.services.permissions.setMode(session.id, "full-access");
			fixture.faux.setResponses([
				fauxAssistantMessage(fauxToolCall("write", { path: "accepted.txt", content: "first" }), {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage(
					fauxToolCall(
						"verify_changes",
						{ command: "if ((Get-Content accepted.txt) -ne 'first') { exit 1 }; exit 0" },
						{ id: "original-check" },
					),
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage(
					fauxToolCall("accept_changes", {
						criteria: [
							{ requirement: "File contains first", checkIds: ["original-check"], evidence: "Content matched" },
						],
					}),
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage(
					fauxToolCall(
						tool,
						tool === "write"
							? { path: "accepted.txt", content: "second" }
							: tool === "exec_command"
								? { command: "Set-Content accepted.txt second", yield_time_ms: 1000 }
								: { plan: [{ step: "Another requirement", status: "completed" }] },
					),
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("完成"),
			]);
			const run = fixture.application.events.start(session.id, { text: "实现并验收" });
			let accepted = false;
			for await (const entry of fixture.application.events.subscribe(run.runId))
				if (entry.event.type === "development.updated" && entry.event.data.acceptance.status === "accepted")
					accepted = true;
			expect(accepted).toBe(true);
			const state = await readDevelopmentState(await fixture.request(`/sessions/${session.id}/runtime-state`));
			expect(state.acceptance.status).toBe("needs_verification");
			expect(state.checks[0].status).toBe("stale");
		} finally {
			await fixture.close();
		}
	},
);

test("PTC concurrent edits cannot produce a current passing verification", async () => {
	const fixture = await createAssistantFixture();
	try {
		const session = await fixture.application.createSession({ profileSlug: "ptc" });
		await fixture.application.services.permissions.setMode(session.id, "full-access");
		fixture.faux.setResponses([
			fauxAssistantMessage(
				fauxToolCall("run_code", {
					code: 'const checking = tools.verify_changes({ command: "Start-Sleep -Milliseconds 300; Write-Output checked; exit 0" }); await tools.write({ path: "raced.txt", content: "changed while checking" }); await checking;',
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("本轮结束"),
		]);
		const run = fixture.application.events.start(session.id, { text: "并行检查与修改" });
		for await (const _entry of fixture.application.events.subscribe(run.runId)) {
		}
		const state = await readDevelopmentState(await fixture.request(`/sessions/${session.id}/runtime-state`));
		expect(state.checks[0].status).toBe("stale");
		expect(state.acceptance.status).toBe("needs_verification");
	} finally {
		await fixture.close();
	}
});

async function readDevelopmentState(response: Response): Promise<DevelopmentState> {
	const result: unknown = await response.json();
	if (
		typeof result !== "object" ||
		result === null ||
		!("development" in result) ||
		!isDevelopmentState(result.development)
	) {
		throw new Error("Runtime state did not contain valid development evidence");
	}
	return result.development;
}

test("ending a round after editing without a check cannot accept the development work", async () => {
	const fixture = await createAssistantFixture();
	try {
		const session = await fixture.application.createSession({ profileSlug: "standard" });
		fixture.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("write", { path: "unchecked.ts", content: "export const value = 1;" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("功能已完成"),
		]);
		const run = fixture.application.events.start(session.id, { text: "修改代码" });
		let completed = false;
		for await (const entry of fixture.application.events.subscribe(run.runId)) {
			if (entry.event.type === "run.completed") {
				completed = true;
				expect(entry.event.data).toMatchObject({ acceptance: { status: "needs_verification" } });
			}
		}
		expect(completed).toBe(true);
		await fixture.restart();
		expect(await readDevelopmentState(await fixture.request(`/sessions/${session.id}/runtime-state`))).toMatchObject({
			acceptance: { status: "needs_verification", criteria: [] },
		});
	} finally {
		await fixture.close();
	}
});

test("Standard, PTC and Creator provide the development workflow, while Minimal keeps only its shell", async () => {
	const fixture = await createAssistantFixture();
	try {
		const coding = await fixture.application.services.profiles.getBySlug("standard");
		expect(coding.tools).toContain("update_plan");
		expect(coding.tools).toContain("verify_changes");
		expect(coding.systemPrompt).toContain("AGENTS.md");
		expect(coding.systemPrompt).toContain("verify_changes");
		for (const slug of ["ptc", "creator"]) {
			expect((await fixture.application.services.profiles.getBySlug(slug)).tools).toContain("verify_changes");
		}
		expect((await fixture.application.services.profiles.getBySlug("minimal")).tools).toEqual(["persistent_shell"]);
		const skill = await readFile(join(fixture.application.paths.skills, "coding", "SKILL.md"), "utf8");
		expect(skill).toContain("verify_changes");
		await writeFile(join(fixture.application.paths.skills, "coding", "SKILL.md"), `${skill}\nLocal instructions.\n`);
		await fixture.application.services.profiles.update(
			coding.id,
			{ ...coding, systemPrompt: "Custom development instructions", tools: ["read"] },
			coding.version,
		);
		await fixture.restart();
		expect((await fixture.application.services.profiles.get(coding.id)).systemPrompt).toBe(
			"Custom development instructions",
		);
		expect((await fixture.application.services.profiles.get(coding.id)).tools).toEqual(["read"]);
		expect(await readFile(join(fixture.application.paths.skills, "coding", "SKILL.md"), "utf8")).toContain(
			"Local instructions.",
		);
	} finally {
		await fixture.close();
	}
});

test("real verification records exit codes, invalidates checks after edits and survives a restart", async () => {
	const fixture = await createAssistantFixture();
	try {
		const session = await fixture.application.createSession({ profileSlug: "standard" });
		fixture.faux.setResponses([
			fauxAssistantMessage(
				fauxToolCall("update_plan", { plan: [{ step: "Implement and check", status: "in_progress" }] }),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(fauxToolCall("write", { path: "workflow.txt", content: "first" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage(fauxToolCall("verify_changes", { command: "Write-Output failed-check; exit 7" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage(fauxToolCall("verify_changes", { command: "Get-Content workflow.txt; exit 0" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage(fauxToolCall("write", { path: "workflow.txt", content: "second" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("修改后需要重新验证"),
		]);
		const run = fixture.application.events.start(session.id, { text: "实现功能并验证" });
		for (let index = 0; index < 2; index++) {
			await expect
				.poll(async () => (await fixture.application.repositories.approvals.listPending()).length, {
					timeout: 5_000,
				})
				.toBe(1);
			const [approval] = await fixture.application.repositories.approvals.listPending();
			expect(approval.toolName).toBe("verify_changes");
			await fixture.application.services.permissions.resolve(approval.id, "approved");
		}
		const updates: unknown[] = [];
		for await (const entry of fixture.application.events.subscribe(run.runId)) {
			if (entry.event.type === "development.updated") updates.push(entry.event.data);
		}
		expect(updates).toContainEqual(
			expect.objectContaining({
				checks: expect.arrayContaining([expect.objectContaining({ status: "failed", exitCode: 7 })]),
			}),
		);
		expect(updates).toContainEqual(
			expect.objectContaining({
				checks: expect.arrayContaining([expect.objectContaining({ status: "passed", exitCode: 0 })]),
			}),
		);
		await fixture.restart();
		const response = await fixture.request(`/sessions/${session.id}/runtime-state`);
		expect(response.status).toBe(200);
		const result = await readDevelopmentState(response);
		expect(result).toMatchObject({
			runId: run.runId,
			plan: [{ step: "Implement and check", status: "in_progress" }],
			changedFiles: ["workflow.txt"],
			checks: [
				{ status: "stale", exitCode: 7 },
				{ status: "stale", exitCode: 0 },
			],
		});
		expect(result.checks[0].output).toContain("failed-check");
		fixture.faux.setResponses([fauxAssistantMessage("仅回答问题")]);
		const next = fixture.application.events.start(session.id, { text: "说明修改" });
		for await (const _entry of fixture.application.events.subscribe(next.runId)) {
			// Drain through settlement before reading the new run's state.
		}
		const nextState = await readDevelopmentState(await fixture.request(`/sessions/${session.id}/runtime-state`));
		expect(nextState).toMatchObject({ runId: next.runId, plan: [], checks: [], changedFiles: [] });
	} finally {
		await fixture.close();
	}
}, 20_000);

test("stopping verification while waiting for approval never executes the command", async () => {
	const fixture = await createAssistantFixture();
	try {
		const session = await fixture.application.createSession({ profileSlug: "standard" });
		fixture.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("verify_changes", { command: "Set-Content denied.txt executed" }), {
				stopReason: "toolUse",
			}),
		]);
		const run = fixture.application.events.start(session.id, { text: "验证" });
		await expect.poll(async () => (await fixture.application.repositories.approvals.listPending()).length).toBe(1);
		await fixture.application.events.abort(session.id);
		for await (const _entry of fixture.application.events.subscribe(run.runId)) {
			// Wait for cancellation to be persisted.
		}
		expect(await fixture.application.repositories.approvals.listPending()).toHaveLength(0);
		await expect(readFile(join(session.cwd, "denied.txt"), "utf8")).rejects.toMatchObject({
			code: "ENOENT",
		});
		const state = await readDevelopmentState(await fixture.request(`/sessions/${session.id}/runtime-state`));
		expect(state.checks).not.toContainEqual(expect.objectContaining({ status: "passed" }));
	} finally {
		await fixture.close();
	}
});

test("PTC nested plan, edits and verification produce the same persisted development evidence", async () => {
	const fixture = await createAssistantFixture();
	try {
		const session = await fixture.application.createSession({ profileSlug: "ptc" });
		await fixture.application.services.permissions.setMode(session.id, "full-access");
		fixture.faux.setResponses([
			fauxAssistantMessage(
				fauxToolCall("run_code", {
					code: 'await tools.update_plan({ plan: [{ step: "PTC change", status: "in_progress" }] }); await tools.write({ path: "ptc-workflow.txt", content: "verified" }); const result = await tools.verify_changes({ command: "if ((Get-Content ptc-workflow.txt) -ne \'verified\') { exit 1 }; Write-Output verified; exit 0" }); const checkId = result.content.find(part => part.type === "text" && part.text.startsWith("Verification ID: "))?.text.split(";")[0].slice("Verification ID: ".length); if (!checkId) throw new Error("Missing verification ID"); await tools.update_plan({ plan: [{ step: "PTC change", status: "completed" }] }); await tools.accept_changes({ criteria: [{ requirement: "PTC change", checkIds: [checkId], evidence: "Actual file content matched" }] });',
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("完成"),
		]);
		const { runId } = fixture.application.events.start(session.id, {
			text: "通过程序修改并验证",
			context: (await fixture.application.contextForSession(session.id)).runtime,
		});
		let sawCheck = false;
		for await (const entry of fixture.application.events.subscribe(runId))
			if (
				entry.event.type === "development.updated" &&
				entry.event.data.checks.some((check) => check.status === "passed")
			)
				sawCheck = true;
		expect(sawCheck).toBe(true);
		await fixture.restart();
		const state = await readDevelopmentState(await fixture.request(`/sessions/${session.id}/runtime-state`));
		expect(state).toMatchObject({
			runId,
			plan: [{ step: "PTC change", status: "completed" }],
			changedFiles: ["ptc-workflow.txt"],
			checks: [{ status: "passed", exitCode: 0 }],
			acceptance: { status: "accepted" },
		});
		expect(state.checks[0].output).toContain("verified");
		expect(JSON.stringify(await fixture.application.services.sessions.readTranscript(session.id))).toContain(
			"verify_changes",
		);
	} finally {
		await fixture.close();
	}
}, 20_000);

test("legacy coding migrates to PTC once and upgrades the stock skill while retaining the selected model and old revision", async () => {
	const fixture = await createAssistantFixture();
	try {
		const coding = await fixture.application.services.profiles.getBySlug("ptc");
		const saved = (await fixture.application.repositories.profiles.upsert(
			{
				...coding,
				slug: "coding",
				name: "My coding assistant",
				systemPrompt: "Work as a careful coding agent in the selected project workspace.",
				defaultModel: { provider: fixture.model.provider, modelId: fixture.model.id },
				tools: ["read", "powershell"],
				skillIds: [],
				version: coding.version + 1,
			},
			coding.version,
		))!;
		const path = join(fixture.application.paths.skills, "coding", "SKILL.md");
		const skill = await readFile(path, "utf8");
		await writeFile(path, skill.replace(DEVELOPMENT_WORKFLOW, LEGACY_CODING_SKILL));
		await fixture.restart();
		const upgraded = await fixture.application.services.profiles.get(coding.id);
		expect(upgraded).toMatchObject({
			name: "PTC助手",
			slug: "ptc",
			defaultModel: saved.defaultModel,
			version: saved.version + 1,
		});
		expect(upgraded.tools).toEqual(expect.arrayContaining(["run_code", "update_plan", "verify_changes"]));
		expect(upgraded.systemPrompt).toContain(DEVELOPMENT_WORKFLOW);
		expect((await fixture.application.services.profiles.getRevision(coding.id, saved.version)).config).toEqual(saved);
		expect(await readFile(path, "utf8")).toContain(DEVELOPMENT_WORKFLOW);
		await fixture.restart();
		expect((await fixture.application.services.profiles.get(coding.id)).version).toBe(upgraded.version);
	} finally {
		await fixture.close();
	}
});

test("delivered steering revises the plan and invalidates verification even when it makes no file changes", async () => {
	const fixture = await createAssistantFixture();
	let releaseResponse: (() => void) | undefined;
	const responseReady = new Promise<void>((resolve) => {
		releaseResponse = resolve;
	});
	let waiting = false;
	try {
		const session = await fixture.application.createSession({ profileSlug: "standard" });
		await fixture.application.services.permissions.setMode(session.id, "full-access");
		fixture.faux.setResponses([
			fauxAssistantMessage(
				fauxToolCall("update_plan", { plan: [{ step: "Original scope", status: "completed" }] }),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(fauxToolCall("verify_changes", { command: "Write-Output original-check; exit 0" }), {
				stopReason: "toolUse",
			}),
			async (context) => {
				expect(context.systemPrompt).toContain("AGENTS.md");
				expect(JSON.stringify(context.messages)).not.toContain("workbench.development");
				waiting = true;
				await responseReady;
				return fauxAssistantMessage("原任务的检查已结束");
			},
			fauxAssistantMessage(
				fauxToolCall("update_plan", {
					plan: [{ step: "Revised scope", status: "in_progress" }],
					explanation: "Follow the added instruction",
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("新要求仍待验证"),
		]);
		const run = fixture.application.events.start(session.id, { text: "检查原任务" });
		await expect.poll(() => waiting, { timeout: 5_000 }).toBe(true);
		const response = await fixture.request(`/sessions/${session.id}/steer`, {
			method: "POST",
			body: JSON.stringify({ runId: run.runId, text: "增加新的验收要求" }),
		});
		expect(response.status).toBe(202);
		releaseResponse?.();
		for await (const _entry of fixture.application.events.subscribe(run.runId)) {
			// Keep the original run until steering and its revised plan settle.
		}
		await fixture.restart();
		const result = await readDevelopmentState(await fixture.request(`/sessions/${session.id}/runtime-state`));
		expect(result).toMatchObject({
			runId: run.runId,
			plan: [{ step: "Revised scope", status: "in_progress" }],
			checks: [{ status: "stale", exitCode: 0 }],
		});
	} finally {
		releaseResponse?.();
		await fixture.close();
	}
}, 15_000);

test("stopping an executing verification cancels the child process and never records a pass", async () => {
	const fixture = await createAssistantFixture();
	try {
		const session = await fixture.application.createSession({ profileSlug: "standard" });
		await fixture.application.services.permissions.setMode(session.id, "full-access");
		fixture.faux.setResponses([
			fauxAssistantMessage(
				fauxToolCall("verify_changes", {
					command: "Set-Content started.txt yes; Start-Sleep -Seconds 20; Set-Content finished.txt yes",
				}),
				{ stopReason: "toolUse" },
			),
		]);
		const run = fixture.application.events.start(session.id, { text: "执行检查" });
		await expect
			.poll(async () => readFile(join(session.cwd, "started.txt"), "utf8").catch(() => ""), {
				timeout: 5_000,
			})
			.toContain("yes");
		await fixture.application.events.abort(session.id);
		for await (const _entry of fixture.application.events.subscribe(run.runId)) {
			// Read only after the child process and the runtime have settled.
		}
		const result = await readDevelopmentState(await fixture.request(`/sessions/${session.id}/runtime-state`));
		expect(result.checks).toMatchObject([{ status: "cancelled", exitCode: null }]);
		await expect(readFile(join(session.cwd, "finished.txt"), "utf8")).rejects.toMatchObject({
			code: "ENOENT",
		});
	} finally {
		await fixture.close();
	}
}, 15_000);
