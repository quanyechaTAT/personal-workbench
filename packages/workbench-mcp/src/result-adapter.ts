import type { RuntimeToolContent, RuntimeToolResult } from "@earendil-works/workbench-runtime";
import type { CallToolResult } from "@modelcontextprotocol/client";

export function adaptToolResult(result: CallToolResult, maxBytes: number): RuntimeToolResult {
	const content: RuntimeToolContent[] = [];
	for (const block of result.content) {
		switch (block.type) {
			case "text":
				content.push({ type: "text", text: block.text });
				break;
			case "image":
				content.push({ type: "image", data: block.data, mimeType: block.mimeType });
				break;
			case "resource_link":
				content.push({
					type: "resource-link",
					name: block.name,
					uri: block.uri,
					mimeType: block.mimeType,
				});
				break;
			default:
				content.push({ type: "text", text: `[Unsupported MCP result block: ${block.type}]` });
		}
	}
	if (content.length === 0 && result.structuredContent !== undefined) {
		content.push({ type: "text", text: JSON.stringify(result.structuredContent, null, 2) });
	}
	const limited = limitContent(content, maxBytes);
	if (result.structuredContent && Buffer.byteLength(JSON.stringify(result.structuredContent), "utf8") > maxBytes) {
		limited.truncated = true;
		limited.content.push({ type: "text", text: "[Structured MCP result omitted: size limit exceeded]" });
	}
	return {
		content: limited.content,
		structuredContent: limited.truncated ? undefined : result.structuredContent,
		isError: result.isError === true,
		truncated: limited.truncated || undefined,
	};
}

function limitContent(
	content: RuntimeToolContent[],
	maxBytes: number,
): { content: RuntimeToolContent[]; truncated: boolean } {
	let remaining = maxBytes;
	const selected: RuntimeToolContent[] = [];
	for (const block of content) {
		const encoded = JSON.stringify(block);
		const size = Buffer.byteLength(encoded, "utf8");
		if (size <= remaining) {
			selected.push(block);
			remaining -= size;
			continue;
		}
		if (block.type === "text" && remaining > 64) {
			selected.push({
				type: "text",
				text: Buffer.from(block.text, "utf8")
					.subarray(0, remaining - 64)
					.toString("utf8"),
			});
		}
		selected.push({ type: "text", text: "[MCP tool result truncated by Personal Workbench]" });
		return { content: selected, truncated: true };
	}
	return { content: selected, truncated: false };
}
