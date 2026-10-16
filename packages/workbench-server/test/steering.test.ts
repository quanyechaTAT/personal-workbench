import type { Context } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import type { AgentEvent } from "@earendil-works/workbench-runtime";
import { expect, test } from "vitest";
import { createAssistantFixture } from "./assistant-fixture.ts";

test("steering reaches the current Pi run after a waiting tool and persists in order", async () => {
	const fixture = await createAssistantFixture();
	try {
		const session = await fixture.application.createSession({ profileSlug: "standard" });
		const userInputs: string[][] = [];
		const respond = (context: Context) => {
			expect(JSON.stringify(context.messages.at(-1))).toContain("workbench-working-memory");
			userInputs.push(
				context.messages
					.filter((message) => message.role === "user")
					.map((message) =>
						(typeof message.content === "string"
							? message.content
							: message.content
									.filter((part) => part.type === "text")
									.map((part) => part.text)
									.join("\n")
						)
							.split(/\n\s*<workbench-working-memory\b/u)[0]
							.trimEnd(),
					),
			);
			return fauxAssistantMessage("已按追加指令继续");
		};
		fixture.faux.setResponses([
			fauxAssistantMessage(
				fauxToolCall("powershell", { command: "Write-Output should-not-run" }, { id: "waiting-tool" }),
				{ stopReason: "toolUse" },
			),
			respond,
			respond,
		]);
		const run = fixture.application.events.start(session.id, { text: "修复启动问题" });
		await expect.poll(async () => (await fixture.application.repositories.approvals.listPending()).length).toBe(1);
		for (const text of ["只改启动脚本", "保留现有模型配置"]) {
			const response = await fixture.request(`/sessions/${session.id}/steer`, {
				method: "POST",
				body: JSON.stringify({ runId: run.runId, text }),
			});
			expect(response.status).toBe(202);
			expect(await response.json()).toEqual({ runId: run.runId });
		}
		expect(fixture.application.events.getActiveRunId(session.id)).toBe(run.runId);
		const [approval] = await fixture.application.repositories.approvals.listPending();
		await fixture.application.services.permissions.resolve(approval.id, "denied");
		const events: AgentEvent[] = [];
		for await (const entry of fixture.application.events.subscribe(run.runId)) {
			if (entry.event.type !== "stream.reset") events.push(entry.event);
		}
		expect(userInputs.at(-1)).toEqual(["修复启动问题", "只改启动脚本", "保留现有模型配置"]);
		expect(events.filter((event) => event.type === "run.started")).toHaveLength(1);
		expect(events.filter((event) => event.type === "tool.started")).toHaveLength(1);
		expect(events.filter((event) => event.type === "run.completed")).toHaveLength(1);
		expect(events.every((event) => event.runId === run.runId)).toBe(true);
		expect(events).toContainEqual(
			expect.objectContaining({
				type: "input.queue",
				data: expect.objectContaining({ steering: ["只改启动脚本", "保留现有模型配置"], followUp: [] }),
			}),
		);
		expect(events).toContainEqual(
			expect.objectContaining({
				type: "message.started",
				data: expect.objectContaining({ role: "user", text: "只改启动脚本", steering: true }),
			}),
		);
		await fixture.restart();
		const transcript = await fixture.application.services.sessions.readTranscript(session.id);
		expect(transcript.filter((message) => message.role === "user").map((message) => message.content[0].text)).toEqual(
			["修复启动问题", "只改启动脚本", "保留现有模型配置"],
		);
	} finally {
		await fixture.close();
	}
});

test("steering rejects empty input, a stale run and a different or idle session", async () => {
	const fixture = await createAssistantFixture();
	try {
		const session = await fixture.application.createSession({ profileSlug: "standard" });
		const other = await fixture.application.createSession({});
		fixture.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("powershell", { command: "Write-Output wait" }), { stopReason: "toolUse" }),
		]);
		const run = fixture.application.events.start(session.id, { text: "等候批准" });
		await expect.poll(async () => (await fixture.application.repositories.approvals.listPending()).length).toBe(1);
		for (const [id, input, status] of [
			[session.id, { runId: run.runId, text: "  " }, 400],
			[session.id, { runId: "previous-run", text: "过期指令" }, 409],
			[other.id, { runId: run.runId, text: "错误会话" }, 409],
			[session.id, { runId: run.runId, text: "/compact" }, 400],
			[session.id, { runId: run.runId, text: "越权", selection: { skillId: "new-skill" } }, 400],
		] as const) {
			const response = await fixture.request(`/sessions/${id}/steer`, {
				method: "POST",
				body: JSON.stringify(input),
			});
			expect(response.status).toBe(status);
		}
		await fixture.application.events.abort(session.id);
		const response = await fixture.request(`/sessions/${session.id}/steer`, {
			method: "POST",
			body: JSON.stringify({ runId: run.runId, text: "已结束" }),
		});
		expect(response.status).toBe(409);
	} finally {
		await fixture.close();
	}
});

test("stopping discards undelivered steering instead of leaking it into the next run", async () => {
	const fixture = await createAssistantFixture();
	try {
		const session = await fixture.application.createSession({ profileSlug: "standard" });
		fixture.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("powershell", { command: "Write-Output wait" }), { stopReason: "toolUse" }),
		]);
		const run = fixture.application.events.start(session.id, { text: "原始任务" });
		await expect.poll(async () => (await fixture.application.repositories.approvals.listPending()).length).toBe(1);
		const response = await fixture.request(`/sessions/${session.id}/steer`, {
			method: "POST",
			body: JSON.stringify({ runId: run.runId, text: "不应带入下一轮" }),
		});
		expect(response.status).toBe(202);
		const stopped = await fixture.request(`/sessions/${session.id}/abort`, { method: "POST" });
		expect(stopped.status).toBe(202);
		fixture.faux.setResponses([
			(context) => {
				expect(JSON.stringify(context.messages)).not.toContain("不应带入下一轮");
				return fauxAssistantMessage("新任务正常完成");
			},
		]);
		const next = fixture.application.events.start(session.id, { text: "新的任务" });
		for await (const _entry of fixture.application.events.subscribe(next.runId)) {
			// Drain the real runtime through settlement.
		}
		const transcript = await fixture.application.services.sessions.readTranscript(session.id);
		expect(JSON.stringify(transcript)).not.toContain("不应带入下一轮");
		expect(JSON.stringify(transcript)).toContain("新任务正常完成");
	} finally {
		await fixture.close();
	}
});
