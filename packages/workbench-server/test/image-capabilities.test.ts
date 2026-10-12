import { readFile } from "node:fs/promises";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { expect, test } from "vitest";
import { createAssistantFixture } from "./assistant-fixture.ts";

test("text-only models cannot capture browser images or execute visual desktop actions", async () => {
	const fixture = await createAssistantFixture(undefined, { modelInput: ["text"] });
	try {
		const session = await fixture.application.createSession({ profileSlug: "standard" });
		await fixture.application.services.permissions.setMode(session.id, "full-access");
		const results: string[] = [];
		fixture.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("browser_use", { action: "screenshot" }), { stopReason: "toolUse" }),
			(context) => {
				results.push(JSON.stringify(context.messages.at(-1)));
				return fauxAssistantMessage(fauxToolCall("computer_use", { action: "click", x: 0, y: 0 }), {
					stopReason: "toolUse",
				});
			},
			(context) => {
				results.push(JSON.stringify(context.messages.at(-1)));
				return fauxAssistantMessage("请切换视觉模型");
			},
		]);
		const context = await fixture.application.contextForSession(session.id);
		const run = fixture.application.events.start(session.id, { text: "查看图像", context: context.runtime });
		for await (const _entry of fixture.application.events.subscribe(run.runId)) {
			/* drain */
		}
		expect(results).toHaveLength(2);
		for (const result of results) {
			expect(result).toContain("支持图像输入的模型");
			expect(result).toContain('"isError":true');
			expect(result).not.toContain('"type":"image"');
		}
	} finally {
		await fixture.close();
	}
});

test("legacy screenshots are purged and text models never receive images from restored history", async () => {
	const fixture = await createAssistantFixture(undefined, { modelInput: ["text"] });
	try {
		const session = await fixture.application.createSession({ profileSlug: "standard" });
		await fixture.restart();
		const manager = SessionManager.open(session.runtimeRef);
		manager.appendMessage({
			role: "user",
			content: [{ type: "image", mimeType: "image/png", data: "legacy-user-image" }],
			timestamp: Date.now() - 3000,
		});
		manager.appendMessage({
			...fauxAssistantMessage(fauxToolCall("browser_use", { action: "screenshot" }, { id: "legacy-call" }), {
				stopReason: "toolUse",
				timestamp: Date.now() - 2000,
			}),
			provider: fixture.model.provider,
			model: fixture.model.id,
			api: fixture.model.api,
		});
		manager.appendMessage({
			role: "toolResult",
			toolCallId: "legacy-call",
			toolName: "browser_use",
			content: [{ type: "image", mimeType: "image/png", data: "legacy-screenshot-bytes" }],
			isError: false,
			timestamp: Date.now() - 1000,
		});
		let receivedImages = -1;
		fixture.faux.setResponses([
			(context) => {
				receivedImages = context.messages.flatMap((message) =>
					typeof message.content === "string" ? [] : message.content.filter((part) => part.type === "image"),
				).length;
				return fauxAssistantMessage("已读取文本历史");
			},
		]);
		const context = await fixture.application.contextForSession(session.id);
		const run = fixture.application.events.start(session.id, { text: "继续", context: context.runtime });
		for await (const _entry of fixture.application.events.subscribe(run.runId)) {
			/* drain */
		}
		expect(receivedImages).toBe(0);
		const history = await readFile(session.runtimeRef, "utf8");
		expect(history).not.toContain("legacy-screenshot-bytes");
		expect(history).toContain("legacy-user-image");
	} finally {
		await fixture.close();
	}
});
