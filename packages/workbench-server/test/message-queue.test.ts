import type { Context } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import type { AgentEvent, RuntimeInputQueue } from "@earendil-works/workbench-runtime";
import { expect, test } from "vitest";
import { createAssistantFixture } from "./assistant-fixture.ts";

test("queued messages can be edited, removed and steered before the remaining messages run in order", async () => {
	const fixture = await createAssistantFixture();
	try {
		const session = await fixture.application.createSession({ profileSlug: "standard" });
		const requests: string[][] = [];
		const respond = (context: Context) => {
			requests.push(
				context.messages
					.filter((message) => message.role === "user")
					.map((message) =>
						typeof message.content === "string"
							? message.content
							: message.content
									.filter((part) => part.type === "text")
									.map((part) => part.text)
									.join("\n"),
					),
			);
			return fauxAssistantMessage("已处理");
		};
		fixture.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("powershell", { command: "Write-Output wait" }), { stopReason: "toolUse" }),
			respond,
			respond,
			respond,
		]);
		const run = fixture.application.events.start(session.id, { text: "初始任务" });
		await expect.poll(async () => (await fixture.application.repositories.approvals.listPending()).length).toBe(1);
		const enqueue = async (text: string) => {
			const response = await fixture.request(`/sessions/${session.id}/queue`, {
				method: "POST",
				body: JSON.stringify({ runId: run.runId, text }),
			});
			expect(response.status).toBe(202);
			return (await response.json()) as RuntimeInputQueue;
		};
		await enqueue("重复消息");
		await enqueue("重复消息");
		await enqueue("立即补充");
		const queued = await enqueue("最后执行");
		expect(new Set(queued.followUp.map((entry) => entry.id)).size).toBe(4);
		const state = await fixture.request(`/sessions/${session.id}/runtime-state`);
		expect(((await state.json()) as { inputQueue: RuntimeInputQueue }).inputQueue).toEqual(queued);
		const mutate = async (index: number, action: object) => {
			const response = await fixture.request(`/sessions/${session.id}/queue/${queued.followUp[index]!.id}`, {
				method: "PATCH",
				body: JSON.stringify({ runId: run.runId, action }),
			});
			expect(response.status).toBe(200);
		};
		await mutate(0, { kind: "edit", text: "修改后的消息" });
		await mutate(1, { kind: "remove" });
		await mutate(2, { kind: "steer" });
		const [approval] = await fixture.application.repositories.approvals.listPending();
		await fixture.application.services.permissions.resolve(approval.id, "denied");
		const events: AgentEvent[] = [];
		for await (const entry of fixture.application.events.subscribe(run.runId))
			if (entry.event.type !== "stream.reset") events.push(entry.event);
		expect(requests).toEqual([
			["初始任务", "立即补充"],
			["初始任务", "立即补充", "修改后的消息"],
			["初始任务", "立即补充", "修改后的消息", "最后执行"],
		]);
		expect(events.filter((event) => event.type === "run.completed")).toHaveLength(1);
		const late = await fixture.request(`/sessions/${session.id}/queue/${queued.followUp[0]!.id}`, {
			method: "PATCH",
			body: JSON.stringify({ runId: run.runId, action: { kind: "remove" } }),
		});
		expect(late.status).toBe(409);
		await fixture.restart();
		const transcript = await fixture.application.services.sessions.readTranscript(session.id);
		expect(transcript.filter((entry) => entry.role === "user").map((entry) => entry.content[0].text)).toEqual([
			"初始任务",
			"立即补充",
			"修改后的消息",
			"最后执行",
		]);
	} finally {
		await fixture.close();
	}
});

test("queue rejects commands, stale runs and blank edits, and stop discards pending messages", async () => {
	const fixture = await createAssistantFixture();
	try {
		const session = await fixture.application.createSession({ profileSlug: "standard" });
		fixture.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("powershell", { command: "Write-Output wait" }), { stopReason: "toolUse" }),
		]);
		const run = fixture.application.events.start(session.id, { text: "等待" });
		await expect.poll(async () => (await fixture.application.repositories.approvals.listPending()).length).toBe(1);
		for (const [runId, text, status] of [
			[run.runId, "  ", 400],
			["old", "过期", 409],
			[run.runId, "/compact", 400],
		] as const) {
			const response = await fixture.request(`/sessions/${session.id}/queue`, {
				method: "POST",
				body: JSON.stringify({ runId, text }),
			});
			expect(response.status).toBe(status);
		}
		const response = await fixture.request(`/sessions/${session.id}/queue`, {
			method: "POST",
			body: JSON.stringify({ runId: run.runId, text: "未送达消息" }),
		});
		expect(response.status).toBe(202);
		const queue = (await response.json()) as RuntimeInputQueue;
		const invalid = await fixture.request(`/sessions/${session.id}/queue/${queue.followUp[0]!.id}`, {
			method: "PATCH",
			body: JSON.stringify({ runId: run.runId, action: { kind: "edit", text: " " } }),
		});
		expect(invalid.status).toBe(400);
		await fixture.application.events.abort(session.id);
		const stopped = (await (await fixture.request(`/sessions/${session.id}/runtime-state`)).json()) as {
			inputQueue: RuntimeInputQueue;
		};
		expect(stopped.inputQueue.followUp).toEqual([]);
		fixture.faux.setResponses([
			(context) => {
				expect(JSON.stringify(context.messages)).not.toContain("未送达消息");
				return fauxAssistantMessage("下一轮");
			},
		]);
		const next = fixture.application.events.start(session.id, { text: "新任务" });
		for await (const _entry of fixture.application.events.subscribe(next.runId)) {
			/* drain */
		}
	} finally {
		await fixture.close();
	}
});

test("a queued question cannot erase unverified edits from the preceding request", async () => {
	const fixture = await createAssistantFixture();
	let release: (() => void) | undefined;
	try {
		const session = await fixture.application.createSession({ profileSlug: "standard" });
		await fixture.application.services.permissions.setMode(session.id, "full-access");
		fixture.faux.setResponses([
			async () => {
				await new Promise<void>((resolve) => {
					release = resolve;
				});
				return fauxAssistantMessage(fauxToolCall("write", { path: "unchecked.html", content: "changed" }), {
					stopReason: "toolUse",
				});
			},
			fauxAssistantMessage("文件已改"),
			fauxAssistantMessage("你好"),
		]);
		const run = fixture.application.events.start(session.id, { text: "修改文件" });
		await expect.poll(() => Boolean(release)).toBe(true);
		expect(
			(
				await fixture.request(`/sessions/${session.id}/queue`, {
					method: "POST",
					body: JSON.stringify({ runId: run.runId, text: "回答你好" }),
				})
			).status,
		).toBe(202);
		release!();
		for await (const _entry of fixture.application.events.subscribe(run.runId)) {
			/* drain */
		}
		expect(await fixture.application.services.sessions.readDevelopmentState(session.id)).toMatchObject({
			requiresAcceptance: true,
			changedFiles: ["unchecked.html"],
			acceptance: { status: "needs_verification" },
		});
	} finally {
		release?.();
		await fixture.close();
	}
});
