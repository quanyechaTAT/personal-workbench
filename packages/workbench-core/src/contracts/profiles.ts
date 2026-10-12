import { type Static, Type } from "typebox";

export const ModelRefSchema = Type.Object(
	{ provider: Type.String({ minLength: 1 }), modelId: Type.String({ minLength: 1 }) },
	{ additionalProperties: false },
);

export const AssistantMcpToolBindingSchema = Type.Object(
	{
		connectionId: Type.String({ minLength: 1 }),
		toolName: Type.String({ minLength: 1 }),
		approvedDefinitionHash: Type.String({ minLength: 1 }),
		approval: Type.Union([Type.Literal("ask"), Type.Literal("allow")]),
	},
	{ additionalProperties: false },
);

export const SaveAgentProfileSchema = Type.Object(
	{
		name: Type.String({ minLength: 1, maxLength: 120 }),
		description: Type.Optional(Type.String({ maxLength: 2_000 })),
		systemPrompt: Type.String({ minLength: 1, maxLength: 100_000 }),
		defaultModel: Type.Optional(ModelRefSchema),
		tools: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { maxItems: 64 })),
		skillIds: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { maxItems: 256 })),
		mcpBindings: Type.Optional(Type.Array(AssistantMcpToolBindingSchema, { maxItems: 512 })),
	},
	{ additionalProperties: false },
);

export const UpdateAgentProfileSchema = Type.Object(
	{ ...SaveAgentProfileSchema.properties, expectedVersion: Type.Integer({ minimum: 1 }) },
	{ additionalProperties: false },
);

export type SaveAgentProfileRequest = Static<typeof SaveAgentProfileSchema>;
export type UpdateAgentProfileRequest = Static<typeof UpdateAgentProfileSchema>;
