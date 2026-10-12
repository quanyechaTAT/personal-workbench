import type { RuntimeTranscriptMessage } from "@earendil-works/workbench-runtime";
import { expect, test } from "vitest";
import { learningSources, redactLearningText } from "../../workbench-core/src/learning.ts";

test("review input contains only the latest turn, excludes reasoning/images/arguments and redacts secrets", () => {
	const messages: RuntimeTranscriptMessage[] = [
		{ id: "past", role: "user", timestamp: "2026-01-01", content: [{ type: "text", text: "旧任务" }] },
		{
			id: "u",
			role: "user",
			timestamp: "2026-01-02",
			content: [{ type: "text", text: "记住项目约束\napi_key=private-value" }],
		},
		{
			id: "a",
			role: "assistant",
			timestamp: "2026-01-02",
			content: [
				{ type: "reasoning", text: "PRIVATE_REASONING" },
				{ type: "tool-call", arguments: { password: "PRIVATE_ARGUMENT" } },
				{ type: "image", data: "PRIVATE_IMAGE" },
				{ type: "text", text: "完成" },
			],
		},
		{ id: "ok", role: "tool", timestamp: "2026-01-02", content: [{ type: "text", text: "真实结果" }] },
		{
			id: "bad",
			role: "tool",
			timestamp: "2026-01-02",
			isError: true,
			content: [{ type: "text", text: "失败结果" }],
		},
	];
	const result = learningSources(messages);
	expect(result.map((entry) => entry.id)).toEqual(["u", "a", "ok", "bad"]);
	expect(JSON.stringify(result)).not.toMatch(/PRIVATE_|private-value|旧任务/u);
	expect(result.map((entry) => entry.verified)).toEqual([true, false, true, false]);
	expect(redactLearningText("Authorization: Bearer secret-value\nsk-abcdefghijklmnopqrst")).not.toContain(
		"secret-value",
	);
});

test("review snapshots respect run timestamps and remain bounded", () => {
	const messages: RuntimeTranscriptMessage[] = Array.from({ length: 100 }, (_, index) => ({
		id: String(index),
		role: "tool",
		timestamp: new Date(index * 1000).toISOString(),
		content: [{ type: "text", text: "x".repeat(5000) }],
	}));
	const result = learningSources(messages, new Date(80000).toISOString(), new Date(95000).toISOString());
	expect(result.length).toBeLessThanOrEqual(40);
	expect(result.reduce((sum, entry) => sum + entry.text.length, 0)).toBeLessThanOrEqual(24000);
	expect(result.every((entry) => Number(entry.id) >= 80 && Number(entry.id) <= 95)).toBe(true);
	expect(result.at(-1)?.id).toBe("95");
});
