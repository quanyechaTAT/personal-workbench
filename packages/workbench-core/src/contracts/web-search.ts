import { type Static, Type } from "typebox";

export type { WebSearchInput, WebSearchResult } from "@earendil-works/workbench-runtime";

export const WebSearchSchema = Type.Object(
	{
		query: Type.String({ minLength: 2, maxLength: 512 }),
		allowed_domains: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 253 }), { maxItems: 20 })),
		blocked_domains: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 253 }), { maxItems: 20 })),
		max_results: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })),
	},
	{ additionalProperties: false },
);
export const SaveSearchSettingsSchema = Type.Object(
	{
		enabled: Type.Boolean(),
		expectedVersion: Type.Integer({ minimum: 0 }),
	},
	{ additionalProperties: false },
);
export type SaveSearchSettingsInput = Static<typeof SaveSearchSettingsSchema>;
export interface SearchSettingsDto {
	enabled: boolean;
	provider: string;
	modelId: string;
	endpoint: string;
	configured: boolean;
	version: number;
}
