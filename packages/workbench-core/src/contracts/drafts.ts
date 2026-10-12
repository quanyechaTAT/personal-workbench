import { type Static, Type } from "typebox";
import { ModelRefSchema, SaveAgentProfileSchema } from "./profiles.ts";

export const CreateAssistantDraftSchema = Type.Object(
	{
		requirement: Type.String({ minLength: 1, maxLength: 20_000 }),
		model: Type.Optional(ModelRefSchema),
	},
	{ additionalProperties: false },
);

export const UpdateAssistantDraftSchema = Type.Object(
	{
		expectedVersion: Type.Integer({ minimum: 1 }),
		config: SaveAgentProfileSchema,
	},
	{ additionalProperties: false },
);

export type CreateAssistantDraftRequest = Static<typeof CreateAssistantDraftSchema>;
export type UpdateAssistantDraftRequest = Static<typeof UpdateAssistantDraftSchema>;
