import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { AgentEvent } from "../src/api.ts";
import { LiveEvents, latestOpenSessionId, visibleStreamHistory } from "../src/chat-page.tsx";
import { formatRelative } from "../src/ui.tsx";

afterEach(() => vi.useRealTimers());

describe("formatRelative", () => {
	test("formats recent session activity without locale-dependent output", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-09-15T08:00:00.000Z"));
		expect(formatRelative("2026-09-15T07:59:40.000Z")).toBe("刚刚");
		expect(formatRelative("2026-09-15T07:42:00.000Z")).toBe("18 分钟前");
		expect(formatRelative("2026-09-14T05:00:00.000Z")).toBe("1 天前");
	});
});

describe("Chat execution presentation", () => {
	test("history and SSE replay never show the same response even with earlier provider timestamps", () => {
		const history = [
			{
				id: "old",
				role: "assistant" as const,
				timestamp: "2026-09-25T08:00:00Z",
				content: [{ type: "text" as const, text: "前一轮" }],
			},
			{
				id: "input",
				role: "user" as const,
				timestamp: "2026-09-26T08:00:01Z",
				content: [{ type: "text" as const, text: "继续" }],
			},
			{
				id: "new",
				role: "assistant" as const,
				timestamp: "2026-09-26T07:59:59Z",
				content: [{ type: "text" as const, text: "本轮回答" }],
			},
		];
		const events = [
			{
				id: "start",
				type: "run.started" as const,
				sessionId: "session",
				runId: "run",
				occurredAt: "2026-09-26T08:00:00Z",
				data: { inputId: "input", historyMessageCount: 1 },
			},
		];
		expect(visibleStreamHistory(history, events).map((message) => message.id)).toEqual(["old", "input"]);
		expect(visibleStreamHistory(history, [])).toEqual(history);
	});
	test("replayed steering stays in the live timeline instead of appearing twice in history", () => {
		const history = ["previous", "input", "steering"].map((id, index) => ({
			id,
			role: "user" as const,
			timestamp: `2026-10-02T00:00:0${index}Z`,
			content: [{ type: "text" as const, text: id }],
		}));
		const events: AgentEvent[] = [
			{
				id: "start",
				type: "run.started",
				sessionId: "session",
				runId: "run",
				occurredAt: "2026-10-02T00:00:01Z",
				data: { inputId: "input", historyMessageCount: 1 },
			},
		];
		expect(visibleStreamHistory(history, events).map((message) => message.id)).toEqual(["previous", "input"]);
	});
	test("shows live tool updates and final results", () => {
		const base = {
			occurredAt: "2026-09-15T08:00:00.000Z",
			sessionId: "session-1",
			runId: "run-1",
		};
		const events: AgentEvent[] = [
			{
				...base,
				id: "event-1",
				type: "tool.updated",
				data: { toolCallId: "tool-1", toolName: "research", update: "partial output" },
			},
			{
				...base,
				id: "event-2",
				type: "tool.completed",
				data: { toolCallId: "tool-1", toolName: "research", result: "final result", isError: false },
			},
		];

		const html = renderToStaticMarkup(createElement(LiveEvents, { events }));
		expect(html).toContain("partial output");
		expect(html).toContain("final result");
	});

	test("chooses the most recently active open project session", () => {
		expect(
			latestOpenSessionId([
				{
					id: "older",
					agentProfileId: "general",
					title: "Older",
					kind: "project",
					status: "idle",
					createdAt: "2026-09-14T08:00:00.000Z",
					lastActiveAt: "2026-09-14T08:00:00.000Z",
				},
				{
					id: "closed-latest",
					agentProfileId: "general",
					title: "Closed",
					kind: "project",
					status: "closed",
					createdAt: "2026-09-16T08:00:00.000Z",
					lastActiveAt: "2026-09-16T08:00:00.000Z",
				},
				{
					id: "recent",
					agentProfileId: "general",
					title: "Recent",
					kind: "project",
					status: "idle",
					createdAt: "2026-09-15T08:00:00.000Z",
					lastActiveAt: "2026-09-15T08:00:00.000Z",
				},
				{
					id: "archived-latest",
					agentProfileId: "general",
					title: "Archived",
					kind: "project",
					status: "idle",
					archivedAt: "2026-09-17T08:00:00.000Z",
					createdAt: "2026-09-17T08:00:00.000Z",
					lastActiveAt: "2026-09-17T08:00:00.000Z",
				},
			]),
		).toBe("recent");
	});
});
