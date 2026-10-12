import { createHash } from "node:crypto";
import { WorkbenchError } from "./errors.ts";
import type { MemoryKind } from "./models.ts";
import type { SemanticMemory } from "./semantic-memory.ts";

export const memoryHash = (text: string) => createHash("sha256").update(text).digest("hex");
export function projectContext(content: string): string {
	// Only explicitly marked project metadata bypasses recall. A manually replaced
	// AGENTS document remains ordinary memory, with the same scope and budget rules.
	if (!content.includes("<!-- workbench-project-context -->")) return "";
	const facts = new Set(
		semanticBlocks(content, "project", "").map((block) => block.record.text.replace(/\s+/gu, " ").trim()),
	);
	const context = [
		...content.matchAll(
			/<!-- workbench-project-context -->\r?\n([\s\S]*?)\r?\n<!-- \/workbench-project-context -->/gu,
		),
	]
		.map((match) => withoutSemanticBlocks(match[1]).trim())
		.filter(Boolean)
		.join("\n\n");
	return context
		.split(/\r?\n/gu)
		.filter((line) => !facts.has(line.replace(/\s+/gu, " ").trim()))
		.join("\n")
		.trim();
}
export function withoutProjectContext(content: string): string {
	if (!content.includes("<!-- workbench-project-context -->")) return content;
	return content.replace(
		/<!-- workbench-project-context -->\r?\n[\s\S]*?\r?\n<!-- \/workbench-project-context -->/gu,
		(block) => block.replace(/[^\r\n]/g, ""),
	);
}
export interface SemanticBlock {
	record: SemanticMemory;
	start: number;
	end: number;
}
export function semanticMarkdown(record: SemanticMemory): string {
	const { text, startLine: _start, endLine: _end, externalHash: _external, ...metadata } = record;
	return `<!-- workbench-semantic ${JSON.stringify({ ...metadata, contentHash: memoryHash(text.trim()) })} -->\n${text.trim()}\n<!-- /workbench-semantic -->`;
}
export function semanticBlocks(
	content: string,
	kind: Exclude<MemoryKind, "daily">,
	path: string,
	projectId?: string,
): SemanticBlock[] {
	const blocks: SemanticBlock[] = [];
	for (const match of content.matchAll(
		/<!-- workbench-semantic (\{[^\n]*\}) -->\r?\n([\s\S]*?)\r?\n<!-- \/workbench-semantic -->/gu,
	)) {
		const data: unknown = JSON.parse(match[1]);
		if (typeof data !== "object" || data === null) throw new WorkbenchError("invalid_input", "语义记忆元数据损坏");
		const value = data as SemanticMemory;
		if (
			typeof value.id !== "string" ||
			!/^[a-z0-9-]{3,128}$/iu.test(value.id) ||
			!Number.isInteger(value.version) ||
			value.version < 1 ||
			!["active", "superseded", "invalidated"].includes(value.status) ||
			!["unknown", "unverified", "verified", "user_confirmed"].includes(value.confirmation) ||
			!["original", "model", "user"].includes(value.origin) ||
			!Array.isArray(value.evidence) ||
			typeof value.validFrom !== "string" ||
			!Number.isFinite(Date.parse(value.validFrom))
		)
			throw new WorkbenchError("invalid_input", "语义记忆元数据无效");
		const text = match[2].trim();
		const changed = value.contentHash !== memoryHash(text);
		const start = match.index;
		blocks.push({
			start,
			end: start + match[0].length,
			record: {
				...value,
				kind,
				relativePath: path,
				projectId,
				text,
				contentHash: memoryHash(text),
				confirmation: changed ? "unknown" : value.confirmation,
				conflict: changed ? "external_edit" : value.conflict,
				startLine: content.slice(0, start).split(/\r?\n/).length,
				endLine: content.slice(0, start + match[0].length).split(/\r?\n/).length,
			},
		});
	}
	const starts = content.match(/<!-- workbench-semantic /g)?.length ?? 0;
	if (starts !== blocks.length || new Set(blocks.map((block) => block.record.id)).size !== blocks.length)
		throw new WorkbenchError("invalid_input", "语义记忆锚点损坏或重复，请恢复 Markdown 版本");
	return blocks;
}
export function withoutSemanticBlocks(content: string): string {
	return content.replace(
		/<!-- workbench-semantic [^\n]* -->\r?\n[\s\S]*?\r?\n<!-- \/workbench-semantic -->/gu,
		(block) => block.replace(/[^\r\n]/g, ""),
	);
}
export function replaceSemanticBlocks(content: string, blocks: SemanticBlock[], updates: SemanticMemory[]): string {
	let result = content;
	for (const block of [...blocks].reverse()) {
		const update = updates.find((record) => record.id === block.record.id);
		if (update) result = result.slice(0, block.start) + semanticMarkdown(update) + result.slice(block.end);
	}
	for (const update of updates.filter((record) => !blocks.some((block) => block.record.id === record.id)))
		result = `${result.trimEnd()}\n\n${semanticMarkdown(update)}\n`;
	return result;
}
