import { setImmediate } from "node:timers/promises";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { expect, test } from "vitest";
import { createAssistantFixture } from "./assistant-fixture.ts";

test("shutdown waits for pending context requests before closing logs and database", async () => {
	let waiting = false;
	let entered: (() => void) | undefined;
	let release: (() => void) | undefined;
	const pendingEntered = new Promise<void>((resolve) => {
		entered = resolve;
	});
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const fixture = await createAssistantFixture(undefined, {
		systemFolders: {
			readDesktop: async () => {
				if (waiting) {
					entered?.();
					await gate;
				}
				return { source: "unavailable", diagnostic: "test context" };
			},
		},
	});
	try {
		const session = await fixture.application.createSession({});
		waiting = true;
		const request = fixture.request(`/sessions/${session.id}/context`).catch((error: unknown) => error);
		await pendingEntered;
		let restarted = false;
		const restart = fixture.restart().then(() => {
			restarted = true;
		});
		await setImmediate();
		await setImmediate();
		expect(restarted).toBe(false);
		expect(await fixture.application.repositories.sessions.get(session.id)).toBeDefined();
		release?.();
		await restart;
		await request;
		expect(await fixture.application.services.sessions.get(session.id)).toBeDefined();
	} finally {
		release?.();
		await fixture.close();
	}
});

test("restart cancels all concurrent Pi runs and keeps both conversations separate", async () => {
	const fixture = await createAssistantFixture(undefined, { tokensPerSecond: 6 });
	try {
		fixture.faux.setResponses([
			fauxAssistantMessage("关闭前第一会话输出。".repeat(60)),
			fauxAssistantMessage("关闭前第二会话输出。".repeat(60)),
		]);
		const first = await fixture.application.createSession({ title: "关闭前一" });
		const second = await fixture.application.createSession({ title: "关闭前二" });
		const runIds: string[] = [];
		for (const [sessionId, text] of [
			[first.id, "关闭前第一条"],
			[second.id, "关闭前第二条"],
		]) {
			const response = await fixture.request(`/sessions/${sessionId}/messages`, {
				method: "POST",
				body: JSON.stringify({ text }),
			});
			expect(response.status).toBe(202);
			const { runId } = (await response.json()) as { runId: string };
			runIds.push(runId);
		}
		for (const runId of runIds) {
			for await (const entry of fixture.application.events.subscribe(runId)) {
				if (entry.event.type === "message.text.delta") break;
			}
		}
		expect((await fixture.application.services.sessions.get(first.id)).status).toBe("running");
		expect((await fixture.application.services.sessions.get(second.id)).status).toBe("running");
		await fixture.restart();
		const firstHistory = JSON.stringify(await fixture.application.services.sessions.readTranscript(first.id));
		const secondHistory = JSON.stringify(await fixture.application.services.sessions.readTranscript(second.id));
		expect(firstHistory).toContain("关闭前第一条");
		expect(firstHistory).not.toContain("关闭前第二条");
		expect(secondHistory).toContain("关闭前第二条");
		expect(secondHistory).not.toContain("关闭前第一条");
		for (const id of [first.id, second.id]) {
			expect((await fixture.application.services.sessions.get(id)).status).toBe("idle");
			expect(fixture.application.events.getActiveRunId(id)).toBeUndefined();
		}
	} finally {
		await fixture.close();
	}
}, 30_000);
