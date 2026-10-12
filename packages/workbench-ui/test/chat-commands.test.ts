import { expect, test } from "vitest";
import { parseChatCommand } from "../src/chat-commands.tsx";

test("builtins consume only full commands at the beginning, preserve multiline compact instructions and leave Skills to Pi", () => {
	const commands = [{ name: "compact", action: "compact" as const, description: "压缩" }];
	expect(parseChatCommand("/compact 保留任务\n保留目标", commands)?.argument).toBe("保留任务\n保留目标");
	for (const input of ["请解释 /compact", "/skill:compact", "https://example.com/compact", "/unknown", "/compactly"])
		expect(parseChatCommand(input, commands)).toBeUndefined();
});
