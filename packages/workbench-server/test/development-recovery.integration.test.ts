import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { isDevelopmentState } from "@earendil-works/workbench-runtime";
import { expect, test } from "vitest";
import { createAssistantFixture } from "./assistant-fixture.ts";

test.each([
	{ name: "unlinked success", link: undefined, command: "Write-Output checked; exit 0", accepted: false },
	{
		name: "linked corrected command",
		link: "failed-check",
		command: "if ((Get-Content result.txt) -ne 'expected') { exit 1 }; Write-Output recovered; exit 0",
		accepted: true,
	},
	{ name: "failed replacement", link: "failed-check", command: "exit 3", accepted: false },
	{ name: "invented source", link: "invented-check", command: "exit 0", accepted: false },
])("development recovery retains failed evidence and validates $name", async ({ link, command, accepted }) => {
	const fixture = await createAssistantFixture();
	try {
		const session = await fixture.application.createSession({ profileSlug: "standard" });
		await fixture.application.services.permissions.setMode(session.id, "full-access");
		await writeFile(join(session.cwd, "result.txt"), "expected");
		fixture.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("verify_changes", { command: "exit 7" }, { id: "failed-check" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage(
				fauxToolCall(
					"verify_changes",
					{
						command,
						...(link ? { replaces: [{ checkId: link, reason: "修正检查命令并核对相同结果文件要求" }] } : {}),
					},
					{ id: "replacement-check" },
				),
				{ stopReason: "toolUse" },
			),
			(context) => {
				const result = context.messages.at(-1);
				if (result?.role !== "toolResult") throw new Error("Expected real Pi verification result");
				const text = result.content
					.filter((part) => part.type === "text")
					.map((part) => part.text)
					.join("\n");
				// Even a rejected recovery argument must expose its real ID, not leave the model guessing.
				expect(text).toContain("Verification ID: replacement-check");
				return fauxAssistantMessage(
					fauxToolCall("accept_changes", {
						criteria: [
							{
								requirement: "结果文件符合要求",
								checkIds: ["replacement-check"],
								evidence: "实际读取结果文件并比较内容",
							},
						],
					}),
					{ stopReason: "toolUse" },
				);
			},
			(context) => {
				if (!accepted) {
					const result = context.messages.at(-1);
					if (result?.role !== "toolResult") throw new Error("Expected real Pi acceptance result");
					const diagnostic = result.content
						.filter((part) => part.type === "text")
						.map((part) => part.text)
						.find((text) => text.startsWith("Verification state:"));
					expect(diagnostic).toContain('"id":"replacement-check"');
					expect(diagnostic).toContain('"id":"failed-check"');
					expect(diagnostic).not.toContain(command);
					expect(diagnostic).not.toContain('"output"');
				}
				return fauxAssistantMessage("结束");
			},
		]);
		const run = fixture.application.events.start(session.id, { text: "验证并验收结果" });
		for await (const _entry of fixture.application.events.subscribe(run.runId)) {
		}
		const readState = async () => {
			const body: unknown = await (await fixture.request(`/sessions/${session.id}/runtime-state`)).json();
			if (
				typeof body !== "object" ||
				body === null ||
				!("development" in body) ||
				!isDevelopmentState(body.development)
			)
				throw new Error("Missing development state");
			return body.development;
		};
		const state = await readState();
		expect(state.acceptance.status).toBe(accepted ? "accepted" : "needs_verification");
		expect(state.checks[0]).toMatchObject({ id: "failed-check", status: "failed", exitCode: 7 });
		if (accepted)
			expect(state.checks[1].replaces).toEqual([
				{ checkId: "failed-check", reason: "修正检查命令并核对相同结果文件要求" },
			]);
		await fixture.restart();
		expect(await readState()).toEqual(state);
	} finally {
		await fixture.close();
	}
});

test("a recovered check becomes stale after a subsequent edit and cannot cover the new revision", async () => {
	const fixture = await createAssistantFixture();
	try {
		const session = await fixture.application.createSession({ profileSlug: "standard" });
		await fixture.application.services.permissions.setMode(session.id, "full-access");
		fixture.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("verify_changes", { command: "exit 7" }, { id: "failed-check" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage(
				fauxToolCall(
					"verify_changes",
					{
						command: "Write-Output recovered; exit 0",
						replaces: [{ checkId: "failed-check", reason: "修正命令并重新验证相同要求" }],
					},
					{ id: "replacement-check" },
				),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(fauxToolCall("write", { path: "new.txt", content: "changed after check" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage(
				fauxToolCall("accept_changes", {
					criteria: [
						{ requirement: "新改动已验证", checkIds: ["replacement-check"], evidence: "引用先前替代检查" },
					],
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("结束"),
		]);
		const run = fixture.application.events.start(session.id, { text: "检查后再修改并验收" });
		for await (const _entry of fixture.application.events.subscribe(run.runId)) {
		}
		const body: unknown = await (await fixture.request(`/sessions/${session.id}/runtime-state`)).json();
		if (
			typeof body !== "object" ||
			body === null ||
			!("development" in body) ||
			!isDevelopmentState(body.development)
		)
			throw new Error("Missing development state");
		expect(body.development.acceptance.status).toBe("needs_verification");
		expect(body.development.checks[1].status).toBe("stale");
	} finally {
		await fixture.close();
	}
});
