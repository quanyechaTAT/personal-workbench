import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import type { AgentEvent, RuntimeTranscriptMessage, SessionUsage } from "@earendil-works/workbench-runtime";
import { expect, test } from "vitest";
import { createAssistantFixture } from "./assistant-fixture.ts";

test("usage counts all model steps, separates cache input and survives reconnect, compaction and restart", async () => {
	const fixture = await createAssistantFixture(undefined, { tokensPerSecond: 100 });
	try {
		await writeFile(
			join(fixture.root, "pi-agent", "settings.json"),
			JSON.stringify({ compaction: { keepRecentTokens: 1 } }),
		);
		const session = await fixture.application.createSession({ profileSlug: "standard" });
		fixture.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("project_list", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("统计输出速度"),
		]);
		const context = await fixture.application.contextForSession(session.id);
		const run = fixture.application.events.start(session.id, { text: "统计", context: context.runtime });
		const events: AgentEvent[] = [];
		for await (const entry of fixture.application.events.subscribe(run.runId))
			if (entry.event.type !== "stream.reset") events.push(entry.event);
		const state = (await (await fixture.request(`/sessions/${session.id}/runtime-state`)).json()) as {
			usage: SessionUsage;
		};
		const samples = events
			.filter((event) => event.type === "message.completed")
			.filter((event) => event.data.role === "assistant")
			.map((event) => {
				if (!event.data.usage) throw new Error("Provider usage missing");
				return event.data.usage;
			});
		expect(state.usage).toMatchObject({
			turns: 1,
			steps: 2,
			tokens: {
				input: samples.reduce((n, u) => n + u.input, 0),
				output: samples.reduce((n, u) => n + u.output, 0),
				cacheRead: samples.reduce((n, u) => n + u.cacheRead, 0),
				cacheWrite: samples.reduce((n, u) => n + u.cacheWrite, 0),
				totalTokens: samples.reduce((n, u) => n + u.totalTokens, 0),
			},
		});
		expect(state.usage.decodeMs).toBeGreaterThan(0);
		expect(state.usage.contextTokens).toBe(samples.at(-1)?.totalTokens);
		expect(events.filter((event) => event.type === "usage.updated").at(-1)?.data).toEqual(state.usage);
		const history = (await (
			await fixture.request(`/sessions/${session.id}/transcript`)
		).json()) as RuntimeTranscriptMessage[];
		expect(history.filter((message) => message.role === "assistant").map((message) => message.usage)).toEqual(
			samples,
		);
		await fixture.restart();
		expect(
			((await (await fixture.request(`/sessions/${session.id}/runtime-state`)).json()) as { usage: SessionUsage })
				.usage,
		).toEqual(state.usage);
		expect(
			(await (await fixture.request(`/sessions/${session.id}/transcript`)).json()) as RuntimeTranscriptMessage[],
		).toEqual(history);
		fixture.faux.setResponses([
			fauxAssistantMessage("第二轮回答"),
			fauxAssistantMessage("压缩摘要"),
			fauxAssistantMessage("本轮摘要"),
		]);
		const second = fixture.application.events.start(session.id, { text: "继续", context: context.runtime });
		for await (const _entry of fixture.application.events.subscribe(second.runId)) {
			/* drain */
		}
		const beforeCompact = (
			(await (await fixture.request(`/sessions/${session.id}/runtime-state`)).json()) as { usage: SessionUsage }
		).usage;
		const compact = await fixture.request(`/sessions/${session.id}/commands`, {
			method: "POST",
			body: JSON.stringify({ name: "compact" }),
		});
		expect(compact.status, await compact.text()).toBe(200);
		const after = (
			(await (await fixture.request(`/sessions/${session.id}/runtime-state`)).json()) as { usage: SessionUsage }
		).usage;
		expect(after.tokens.totalTokens).toBeGreaterThan(beforeCompact.tokens.totalTokens);
		expect(after.contextTokens).toBeGreaterThan(0);
		expect(after.contextTokensSource).toBe("estimated");
		expect(after.steps).toBe(3);
		await fixture.restart();
		expect(
			((await (await fixture.request(`/sessions/${session.id}/runtime-state`)).json()) as { usage: SessionUsage })
				.usage,
		).toEqual(after);
	} finally {
		await fixture.close();
	}
}, 30_000);
