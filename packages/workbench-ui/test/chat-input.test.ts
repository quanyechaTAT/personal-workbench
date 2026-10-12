import { expect, test } from "vitest";
import { fileToken, slashToken } from "../src/chat-input.tsx";

test("slash completion understands Chinese and Skill prefixes at the caret", () => {
	expect(slashToken("请帮我 /记忆 后续文字", 7)).toMatchObject({ query: "记忆", start: 4, end: 7 });
	expect(slashToken("/skill:research", 15)?.query).toBe("skill:research");
	expect(slashToken("/ask-matt", 9)?.query).toBe("ask-matt");
});

test("slash does not mistake URLs or paths for commands", () => {
	for (const value of ["https://example.com", "C:/Users/user", "files/reports", "a/b"])
		expect(slashToken(value, value.length)).toBeUndefined();
	expect(slashToken("输入 /", 4)?.query).toBe("");
});

test("file popup triggers at a standalone @ token and keeps surrounding text", () => {
	expect(fileToken("请读 @报告 后续", 6)).toEqual({ start: 3, end: 6, query: "报告" });
	expect(fileToken("@", 1)).toEqual({ start: 0, end: 1, query: "" });
	for (const value of ["user@example.com", "https://example.com/@name", "@@", "正文@附件"])
		expect(fileToken(value, value.length)).toBeUndefined();
});
