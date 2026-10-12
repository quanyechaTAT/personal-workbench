import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { DEVELOPMENT_WORKFLOW, PREVIOUS_ACCEPTANCE_WORKFLOW } from "@earendil-works/workbench-core";
import type { DevelopmentState } from "@earendil-works/workbench-runtime";
import { expect, test } from "vitest";
import { createAssistantFixture } from "./assistant-fixture.ts";

test.each(["standard", "ptc"])(
	"%s respects direct generation without testing and does not require acceptance",
	async (profileSlug) => {
		const fixture = await createAssistantFixture();
		try {
			const session = await fixture.application.createSession({ profileSlug });
			await fixture.application.services.permissions.setMode(session.id, "full-access");
			const content = '<!doctype html><svg><circle r="12" /></svg>';
			fixture.faux.setResponses([
				fauxAssistantMessage(
					fauxToolCall(
						profileSlug === "ptc" ? "run_code" : "write",
						profileSlug === "ptc"
							? {
									code: `await tools.write({path:"pelican-bicycle.html",content:${JSON.stringify(content)}});`,
								}
							: { path: "pelican-bicycle.html", content },
					),
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("已创建，按要求未运行测试。"),
			]);
			const run = fixture.application.events.start(session.id, {
				text: "创建一个HTML，内容是用SVG绘制一个鹈鹕骑自行车的2D动画，你不能进行任何测试，不能调用skills，不能网络检索，不能调用子智能体，直接生成",
			});
			let completed = false;
			for await (const entry of fixture.application.events.subscribe(run.runId)) {
				if (entry.event.type === "run.completed") {
					completed = true;
					expect(entry.event.data.acceptance?.status).toBe("not_required");
				}
			}
			expect(completed).toBe(true);
			expect(await readFile(join(session.cwd, "pelican-bicycle.html"), "utf8")).toBe(content);
			await fixture.restart();
			const body = (await (await fixture.request(`/sessions/${session.id}/runtime-state`)).json()) as {
				development: DevelopmentState;
			};
			const state = body.development;
			expect(state).toMatchObject({ requiresAcceptance: false, checks: [], acceptance: { status: "not_required" } });
			expect(state.acceptance.reason).toContain("用户");
		} finally {
			await fixture.close();
		}
	},
);

test("a forbidden verify_changes call cannot execute a command or claim acceptance", async () => {
	const fixture = await createAssistantFixture();
	try {
		const session = await fixture.application.createSession({ profileSlug: "standard" });
		await fixture.application.services.permissions.setMode(session.id, "full-access");
		fixture.faux.setResponses([
			fauxAssistantMessage(
				fauxToolCall("verify_changes", { command: "Set-Content forbidden-test.txt executed; exit 0" }),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("未测试。"),
		]);
		const run = fixture.application.events.start(session.id, { text: "直接生成，不要运行测试" });
		let blocked = false;
		for await (const entry of fixture.application.events.subscribe(run.runId)) {
			if (entry.event.type === "tool.completed" && entry.event.data.toolName === "verify_changes")
				blocked = entry.event.data.isError;
		}
		expect(blocked).toBe(true);
		await expect(readFile(join(session.cwd, "forbidden-test.txt"))).rejects.toMatchObject({ code: "ENOENT" });
		const state = await fixture.application.services.sessions.readDevelopmentState(session.id);
		expect(state).toMatchObject({ checks: [], requiresAcceptance: false, acceptance: { status: "not_required" } });
	} finally {
		await fixture.close();
	}
});

test.each([
	["创建文件，不要跳过测试", "needs_verification"],
	["Create a file. Do not run any tests.", "not_required"],
] as const)("verification policy respects the actual restriction: %s", async (text, status) => {
	const fixture = await createAssistantFixture();
	try {
		const session = await fixture.application.createSession({ profileSlug: "standard" });
		await fixture.application.services.permissions.setMode(session.id, "full-access");
		fixture.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("write", { path: "policy.html", content: "created" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("已创建"),
		]);
		const run = fixture.application.events.start(session.id, { text });
		for await (const _entry of fixture.application.events.subscribe(run.runId)) {
			/* drain */
		}
		expect((await fixture.application.services.sessions.readDevelopmentState(session.id))?.acceptance.status).toBe(
			status,
		);
	} finally {
		await fixture.close();
	}
});

test("stock acceptance instructions upgrade without overwriting customized tools", async () => {
	const fixture = await createAssistantFixture();
	try {
		const profile = await fixture.application.services.profiles.getBySlug("standard");
		await fixture.application.services.profiles.update(
			profile.id,
			{
				...profile,
				tools: ["write"],
				systemPrompt: profile.systemPrompt.replace(DEVELOPMENT_WORKFLOW, PREVIOUS_ACCEPTANCE_WORKFLOW),
			},
			profile.version,
		);
		await fixture.restart();
		const upgraded = await fixture.application.services.profiles.getBySlug("standard");
		expect(upgraded.tools).toEqual(["write"]);
		expect(upgraded.systemPrompt).toBe(profile.systemPrompt);
	} finally {
		await fixture.close();
	}
});
