import type { ConfiguredModelProvider } from "@earendil-works/workbench-runtime";
import { type Static, Type } from "typebox";

export const ThinkingLevelSchema = Type.Union([
	Type.Literal("none"),
	Type.Literal("minimal"),
	Type.Literal("low"),
	Type.Literal("medium"),
	Type.Literal("high"),
	Type.Literal("xhigh"),
	Type.Literal("max"),
]);

export const ConfiguredModelSchema = Type.Object(
	{
		modelId: Type.String({ minLength: 1, maxLength: 200 }),
		name: Type.String({ minLength: 1, maxLength: 200 }),
		enabled: Type.Boolean(),
		reasoning: Type.Boolean(),
		vision: Type.Boolean(),
		contextWindow: Type.Integer({ minimum: 1024, maximum: 10000000 }),
		maxTokens: Type.Integer({ minimum: 128, maximum: 1000000 }),
		thinkingPreset: Type.Union([Type.Literal("auto"), Type.Literal("deepseek")]),
		thinkingLevelMap: Type.Optional(
			Type.Object(
				{
					off: Type.Optional(Type.Union([Type.String({ maxLength: 64 }), Type.Null()])),
					minimal: Type.Optional(Type.Union([Type.String({ maxLength: 64 }), Type.Null()])),
					low: Type.Optional(Type.Union([Type.String({ maxLength: 64 }), Type.Null()])),
					medium: Type.Optional(Type.Union([Type.String({ maxLength: 64 }), Type.Null()])),
					high: Type.Optional(Type.Union([Type.String({ maxLength: 64 }), Type.Null()])),
					xhigh: Type.Optional(Type.Union([Type.String({ maxLength: 64 }), Type.Null()])),
					max: Type.Optional(Type.Union([Type.String({ maxLength: 64 }), Type.Null()])),
				},
				{ additionalProperties: false },
			),
		),
	},
	{ additionalProperties: false },
);

export const SaveModelProviderSchema = Type.Object(
	{
		name: Type.String({ minLength: 1, maxLength: 100 }),
		baseUrl: Type.String({ minLength: 1, maxLength: 2000 }),
		api: Type.String({ minLength: 1, maxLength: 100 }),
		enabled: Type.Boolean(),
		models: Type.Array(ConfiguredModelSchema, { maxItems: 200 }),
		apiKey: Type.Optional(Type.String({ minLength: 1, maxLength: 16384 })),
		expectedVersion: Type.Integer({ minimum: 0 }),
	},
	{ additionalProperties: false },
);
export type SaveModelProviderInput = Static<typeof SaveModelProviderSchema>;
export const DiscoverModelsSchema = Type.Object(
	{
		providerId: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
		baseUrl: Type.String({ minLength: 1, maxLength: 2000 }),
		api: Type.String({ minLength: 1, maxLength: 100 }),
		apiKey: Type.Optional(Type.String({ minLength: 1, maxLength: 16384 })),
		modelsUrl: Type.Optional(Type.String({ minLength: 1, maxLength: 2000 })),
	},
	{ additionalProperties: false },
);
export type DiscoverModelsInput = Static<typeof DiscoverModelsSchema>;
export interface ModelProviderDto extends ConfiguredModelProvider {
	configured: boolean;
	supportsCustomModels?: boolean;
}
export interface ModelSettingsDto {
	version: number;
	providers: ModelProviderDto[];
}
