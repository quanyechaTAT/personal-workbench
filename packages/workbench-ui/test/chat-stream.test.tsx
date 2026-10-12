// @vitest-environment jsdom
import type { AgentEvent, AgentEventData, AgentEventType } from "@earendil-works/workbench-runtime";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { LiveEvents } from "../src/chat-page.tsx";

let sequence = 0;
function event<T extends AgentEventType>(type: T, data: AgentEventData[T]): Extract<AgentEvent, { type: T }> {
	return {
		id: `event-${++sequence}`,
		type,
		data,
		sessionId: "session",
		runId: "run",
		occurredAt: "2026-09-26T01:00:00Z",
	} as Extract<AgentEvent, { type: T }>;
}
function render(events: AgentEvent[]) {
	const node = document.createElement("div");
	node.innerHTML = renderToStaticMarkup(<LiveEvents events={events} />);
	return node;
}

test("normal round completion hides internal acceptance states", () => {
	expect(render([event("run.completed", {})]).querySelector(".message-meta")?.textContent).toContain("本轮结束");
	expect(
		render([
			event("run.completed", { acceptance: { status: "needs_verification", reason: "尚未检查", criteria: [] } }),
		]).querySelector(".message-meta")?.textContent,
	).toContain("本轮结束");
	expect(
		render([
			event("run.completed", { acceptance: { status: "accepted", reason: "证据完整", criteria: [] } }),
		]).querySelector(".message-meta")?.textContent,
	).not.toContain("验收");
});

test("stream keeps distinct messages and tools in execution order", () => {
	const node = render([
		event("message.started", { messageId: "first", role: "assistant" }),
		event("message.text.delta", { messageId: "first", contentIndex: 0, delta: "先读取资料" }),
		event("message.completed", { messageId: "first", role: "assistant" }),
		event("tool.started", { toolCallId: "tool", toolName: "read", arguments: { path: "note.md" } }),
		event("tool.completed", { toolCallId: "tool", toolName: "read", result: "资料内容", isError: false }),
		event("message.started", { messageId: "second", role: "assistant" }),
		event("message.text.delta", { messageId: "second", contentIndex: 0, delta: "读取完毕" }),
	]);
	const blocks = [...node.querySelectorAll(".message-text, .tool-card")];
	expect(blocks.map((block) => block.textContent)).toEqual([
		"先读取资料",
		expect.stringContaining("读取文件"),
		"读取完毕",
	]);
});

test("reasoning stays separate and collapsed while a message streams", () => {
	const node = render([
		event("message.reasoning.delta", { messageId: "reply", contentIndex: 0, delta: "独立思考内容" }),
		event("message.text.delta", { messageId: "reply", contentIndex: 1, delta: "用户可见回答" }),
	]);
	expect(node.querySelector("details.reasoning")?.hasAttribute("open")).toBe(false);
	expect(node.querySelector(".message-text")?.textContent).toBe("用户可见回答");
});

test("replayed events do not duplicate text and a completed run has no typing cursor", () => {
	const delta = event("message.text.delta", { messageId: "reply", contentIndex: 0, delta: "唯一回答" });
	const node = render([delta, delta, event("run.completed", {})]);
	expect(node.querySelector(".message-text")?.textContent).toBe("唯一回答");
	expect(node.querySelector(".stream-cursor")).toBeNull();
});

test("browser and desktop screenshots render as images without dumping base64 into tool text", () => {
	const data = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZJ8AAAAASUVORK5CYII=";
	const node = render([
		event("tool.completed", {
			toolCallId: "capture",
			toolName: "computer_use",
			isError: false,
			result: {
				content: [
					{ type: "text", text: "窗口截图" },
					{ type: "image", mimeType: "image/png", data },
				],
			},
		}),
	]);
	expect(node.querySelector<HTMLImageElement>("img")?.getAttribute("src")).toBe(`data:image/png;base64,${data}`);
	expect(node.textContent).toContain("窗口截图");
	expect(node.textContent).not.toContain(data);
});

test("pending tool approval is visible and approving resumes its execution state", () => {
	const started = event("tool.started", { toolCallId: "shell", toolName: "powershell", arguments: {} });
	const requested = event("permission.requested", {
		approvalId: "approval",
		toolCallId: "shell",
		summary: "批准命令",
	});
	expect(render([started, requested]).querySelector(".status-pill")?.textContent).toBe("等待批准");
	const approved = event("permission.resolved", { approvalId: "approval", decision: "approved" });
	expect(render([started, requested, approved]).querySelector(".status-pill")?.textContent).toBe("执行中");
});

test("delivered steering stays between the running tool and the next reply without duplicating the initial input", () => {
	const node = render([
		event("message.started", { messageId: "input", role: "user", text: "原始任务", steering: false }),
		event("tool.started", { toolCallId: "tool", toolName: "read", arguments: {} }),
		event("message.started", { messageId: "correction", role: "user", text: "只改启动脚本", steering: true }),
		event("message.text.delta", { messageId: "reply", contentIndex: 0, delta: "按追加指令继续" }),
	]);
	const blocks = [...node.querySelectorAll(".tool-card, .steering-message, [data-message-id]")];
	expect(blocks.map((block) => block.textContent)).toEqual([
		expect.stringContaining("读取文件"),
		expect.stringContaining("只改启动脚本"),
		"按追加指令继续",
	]);
	expect(node.textContent).not.toContain("原始任务");
});

test("each completed assistant reply shows its own input, output and total tokens", () => {
	const usage = { input: 100, output: 20, cacheRead: 60, cacheWrite: 10, totalTokens: 190, cost: 0 };
	const delta = event("message.text.delta", { messageId: "reply", contentIndex: 0, delta: "回答" });
	expect(render([delta]).querySelector(".message-usage")).toBeNull();
	const completed = event("message.completed", { messageId: "reply", role: "assistant", usage });
	const node = render([delta, completed, completed, event("run.completed", {})]);
	expect(node.querySelectorAll(".message-usage")).toHaveLength(1);
	expect(node.querySelector(".message-usage")?.textContent).toContain("输入 170");
	expect(node.querySelector(".message-usage")?.textContent).toContain("输出 20");
	expect(node.querySelector(".message-usage")?.textContent).toContain("共 190 tokens");
});

test("missing or invalid provider usage never displays invented per-reply token counts", () => {
	const delta = event("message.text.delta", { messageId: "reply", contentIndex: 0, delta: "回答" });
	const invalid = { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 1, cost: 0 };
	for (const usage of [undefined, invalid]) {
		expect(
			render([delta, event("message.completed", { messageId: "reply", role: "assistant", usage })]).querySelector(
				".message-usage",
			),
		).toBeNull();
	}
});
