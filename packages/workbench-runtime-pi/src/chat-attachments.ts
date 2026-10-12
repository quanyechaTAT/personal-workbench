import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { RuntimeAttachmentReference } from "@earendil-works/workbench-runtime";

export const CHAT_ATTACHMENTS_ENTRY = "workbench.chat-attachments.v1";

export function attachmentTranscriptEntries(entries: readonly SessionEntry[]) {
	let pending: { attachments: RuntimeAttachmentReference[]; suffixLength: number } | undefined;
	return entries.flatMap((entry) => {
		if (entry.type === "custom" && entry.customType === CHAT_ATTACHMENTS_ENTRY) {
			const value: unknown = entry.data;
			pending = undefined;
			if (
				typeof value === "object" &&
				value !== null &&
				"attachments" in value &&
				Array.isArray(value.attachments) &&
				"suffixLength" in value &&
				typeof value.suffixLength === "number" &&
				Number.isInteger(value.suffixLength) &&
				value.suffixLength >= 0
			) {
				const attachments = value.attachments.filter(
					(item: unknown): item is RuntimeAttachmentReference =>
						typeof item === "object" &&
						item !== null &&
						"id" in item &&
						typeof item.id === "string" &&
						"name" in item &&
						typeof item.name === "string" &&
						"mimeType" in item &&
						typeof item.mimeType === "string" &&
						"size" in item &&
						typeof item.size === "number" &&
						"sha256" in item &&
						typeof item.sha256 === "string" &&
						"truncated" in item &&
						typeof item.truncated === "boolean" &&
						"diagnostics" in item &&
						Array.isArray(item.diagnostics) &&
						item.diagnostics.every((text: unknown) => typeof text === "string"),
				);
				pending = { attachments, suffixLength: value.suffixLength };
			}
		}
		if (entry.type !== "message") return [];
		const attachment = entry.message.role === "user" ? pending : undefined;
		if (entry.message.role === "user") pending = undefined;
		return [{ id: entry.id, timestamp: entry.timestamp, message: entry.message, ...attachment }];
	});
}
