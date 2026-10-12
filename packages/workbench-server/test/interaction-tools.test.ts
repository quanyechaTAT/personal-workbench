import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { Context } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import type { AgentEvent } from "@earendil-works/workbench-runtime";
import { expect, test, vi } from "vitest";
import { createAssistantFixture } from "./assistant-fixture.ts";

function imagesIn(messages: Context["messages"]): string[] {
	return messages.flatMap((message) =>
		typeof message.content === "string"
			? []
			: message.content.flatMap((part) => (part.type === "image" ? [part.data] : [])),
	);
}

test("browser tools require approval, hot permission changes unblock them, and PTC records nested calls", async () => {
	const fixture = await createAssistantFixture();
	const server = createServer((_req, res) => {
		res.setHeader("content-type", "text/html; charset=utf-8");
		res.end("<h1>真实本地页面</h1>");
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("No address");
	try {
		const session = await fixture.application.createSession({ profileSlug: "standard" });
		fixture.faux.setResponses([
			fauxAssistantMessage(
				fauxToolCall("browser_use", { action: "open", url: `http://127.0.0.1:${address.port}` }),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("已打开"),
		]);
		const context = await fixture.application.contextForSession(session.id);
		const run = fixture.application.events.start(session.id, { text: "浏览页面", context: context.runtime });
		const events: AgentEvent[] = [];
		const drain = (async () => {
			for await (const entry of fixture.application.events.subscribe(run.runId))
				if (entry.event.type !== "stream.reset") events.push(entry.event);
		})();
		await vi.waitFor(async () =>
			expect((await fixture.application.repositories.approvals.listPending())[0]?.toolName).toBe("browser_use"),
		);
		expect(events.some((event) => event.type === "tool.completed")).toBe(false);
		await fixture.application.services.permissions.setMode(session.id, "full-access");
		await drain;
		const result = events.find((event) => event.type === "tool.completed" && event.data.toolName === "browser_use");
		expect(result?.type === "tool.completed" && result.data.isError, JSON.stringify(events)).toBe(false);
		expect(JSON.stringify(result)).toContain("真实本地页面");
		const imageRequests: string[][] = [];
		fixture.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("browser_use", { action: "screenshot" }), { stopReason: "toolUse" }),
			(context) => {
				imageRequests.push(
					context.messages.flatMap((message) =>
						typeof message.content === "string"
							? []
							: message.content
									.filter((part) => part.type === "image")
									.map((part) => (part.type === "image" ? part.data : "")),
					),
				);
				return fauxAssistantMessage(fauxToolCall("browser_use", { action: "tabs" }), { stopReason: "toolUse" });
			},
			(context) => {
				imageRequests.push(
					context.messages.flatMap((message) =>
						typeof message.content === "string"
							? []
							: message.content
									.filter((part) => part.type === "image")
									.map((part) => (part.type === "image" ? part.data : "")),
					),
				);
				return fauxAssistantMessage("已查看截图");
			},
		]);
		const capture = fixture.application.events.start(session.id, { text: "截图", context: context.runtime });
		for await (const entry of fixture.application.events.subscribe(capture.runId))
			if (entry.event.type !== "stream.reset") events.push(entry.event);
		const images = (await fixture.application.services.sessions.readTranscript(session.id))
			.flatMap((message) => message.content)
			.filter((part) => part.type === "image");
		expect(images).toHaveLength(0);
		expect(imageRequests[0]).toHaveLength(1);
		expect(imageRequests[1]).toEqual([]);
		expect(Buffer.from(imageRequests[0][0], "base64").subarray(1, 4).toString()).toBe("PNG");
		expect(await readFile(session.runtimeRef, "utf8")).not.toContain(imageRequests[0][0]);
		const ptc = await fixture.application.createSession({ profileSlug: "ptc" });
		await fixture.application.services.permissions.setMode(ptc.id, "full-access");
		fixture.faux.setResponses([
			fauxAssistantMessage(
				fauxToolCall("run_code", {
					code: 'const tabs = await tools.browser_use({ action: "tabs" }); const windows = await tools.computer_use({ action: "windows" }); console.log(tabs.content, windows.details.windows.length);',
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("已读取"),
		]);
		const ptcContext = await fixture.application.contextForSession(ptc.id);
		const ptcRun = fixture.application.events.start(ptc.id, { text: "读取标签页", context: ptcContext.runtime });
		for await (const entry of fixture.application.events.subscribe(ptcRun.runId))
			if (entry.event.type !== "stream.reset") events.push(entry.event);
		expect(
			events.some(
				(event) =>
					event.type === "tool.completed" &&
					event.sessionId === ptc.id &&
					event.data.toolName === "browser_use" &&
					!event.data.isError,
			),
		).toBe(true);
		const ptcImages: string[][] = [];
		fixture.faux.setResponses([
			fauxAssistantMessage(
				fauxToolCall("run_code", {
					code: `await tools.browser_use({ action: "open", url: "http://127.0.0.1:${address.port}" }); const shot = await tools.browser_use({ action: "screenshot" }); console.log(shot.content);`,
				}),
				{ stopReason: "toolUse" },
			),
			(context) => {
				ptcImages.push(imagesIn(context.messages));
				return fauxAssistantMessage(
					fauxToolCall("run_code", {
						code: 'console.log((await tools.browser_use({ action: "tabs" })).content);',
					}),
					{ stopReason: "toolUse" },
				);
			},
			(context) => {
				ptcImages.push(imagesIn(context.messages));
				return fauxAssistantMessage("已查看截图");
			},
		]);
		const ptcCapture = fixture.application.events.start(ptc.id, {
			text: "通过程序查看截图",
			context: ptcContext.runtime,
		});
		for await (const _entry of fixture.application.events.subscribe(ptcCapture.runId)) {
			/* drain */
		}
		expect(ptcImages[0]).toHaveLength(1);
		expect(ptcImages[1]).toEqual([]);
		expect(await readFile(ptc.runtimeRef, "utf8")).not.toContain(ptcImages[0][0]);
		await fixture.restart();
		expect(
			(await fixture.application.services.sessions.readTranscript(session.id))
				.flatMap((message) => message.content)
				.filter((part) => part.type === "image"),
		).toEqual(images);
		expect(JSON.stringify(await fixture.application.services.sessions.readTranscript(ptc.id))).toContain(
			"browser_use",
		);
	} finally {
		await fixture.close();
		server.closeAllConnections();
		await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
	}
}, 30_000);

test("desktop tools remain pending until approved and Stop cancels the pending action", async () => {
	const fixture = await createAssistantFixture();
	try {
		const session = await fixture.application.createSession({ profileSlug: "standard" });
		fixture.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("computer_use", { action: "windows" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("停止"),
		]);
		const context = await fixture.application.contextForSession(session.id);
		const run = fixture.application.events.start(session.id, { text: "查看桌面窗口", context: context.runtime });
		const drain = (async () => {
			for await (const _entry of fixture.application.events.subscribe(run.runId)) {
				/* drain */
			}
		})();
		await vi.waitFor(async () =>
			expect((await fixture.application.repositories.approvals.listPending())[0]?.toolName).toBe("computer_use"),
		);
		await fixture.request(`/sessions/${session.id}/abort`, { method: "POST" });
		await drain;
		expect(await fixture.application.repositories.approvals.listPending()).toEqual([]);
		expect((await fixture.application.repositories.agentRuns.get(run.runId))?.status).toBe("aborted");
	} finally {
		await fixture.close();
	}
});
