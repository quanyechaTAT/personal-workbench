import type { RuntimeAttachmentReference } from "@earendil-works/workbench-runtime";
import { type Static, Type } from "typebox";

export const MAX_CHAT_ATTACHMENTS = 8;
export const MAX_CHAT_ATTACHMENT_BYTES = 20 * 1024 * 1024;

export interface ChatAttachment extends RuntimeAttachmentReference {
	sessionId: string;
	createdAt: string;
	textCharacters: number;
}

export const ChatSelectionSchema = Type.Object(
	{
		skillId: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
	},
	{ additionalProperties: false },
);

export type ChatSelection = Static<typeof ChatSelectionSchema>;

export interface ChatCapability {
	id: string;
	kind: "skill";
	name: string;
	label: string;
	description: string;
}

export interface ChatCapabilityCatalog {
	items: ChatCapability[];
	diagnostics: Array<{ code: string; message: string }>;
}
