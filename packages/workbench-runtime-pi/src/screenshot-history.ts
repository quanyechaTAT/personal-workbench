import { randomUUID } from "node:crypto";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { isScreenshotResult } from "./screenshot-extension.ts";

/** Called only for an owned, validated history file before an AgentSession opens it. */
export async function purgeScreenshotHistory(path: string): Promise<void> {
	const original = await readFile(path, "utf8");
	let changed = false;
	const cleaned = original
		.split("\n")
		.map((line) => {
			let entry: unknown;
			try {
				entry = JSON.parse(line);
			} catch {
				return line;
			}
			if (
				typeof entry !== "object" ||
				entry === null ||
				!("type" in entry) ||
				entry.type !== "message" ||
				!("message" in entry)
			)
				return line;
			const message: unknown = entry.message;
			if (
				typeof message !== "object" ||
				message === null ||
				!("role" in message) ||
				message.role !== "toolResult" ||
				!("toolName" in message) ||
				typeof message.toolName !== "string" ||
				!("content" in message) ||
				!Array.isArray(message.content) ||
				!isScreenshotResult(message.toolName, "details" in message ? message.details : undefined)
			)
				return line;
			let replaced = false;
			const content = message.content.map((part: unknown) => {
				if (typeof part === "object" && part !== null && "type" in part && part.type === "image") {
					replaced = true;
					return { type: "text", text: "[截图已清理，需要重看时请重新截图。]" };
				}
				return part;
			});
			if (!replaced) return line;
			changed = true;
			return JSON.stringify({ ...entry, message: { ...message, content } });
		})
		.join("\n");
	if (!changed) return;
	const temporary = `${path}.${randomUUID()}.tmp`;
	try {
		await writeFile(temporary, cleaned, { flag: "wx" });
		await rename(temporary, path);
	} finally {
		await unlink(temporary).catch((error: unknown) => {
			if (!(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")) throw error;
		});
	}
}
