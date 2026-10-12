import { type Static, Type } from "typebox";

export const CreateSkillImportSchema = Type.Object(
	{
		source: Type.Union([Type.Literal("local"), Type.Literal("git")]),
		location: Type.String({ minLength: 1 }),
		ref: Type.Optional(Type.String()),
		subdirectory: Type.Optional(Type.String()),
		scope: Type.Union([Type.Literal("global"), Type.Literal("project")]),
		projectId: Type.Optional(Type.String()),
	},
	{ additionalProperties: false },
);

export const CreateSkillSchema = Type.Object(
	{
		slug: Type.String({ minLength: 1, maxLength: 64 }),
		name: Type.String({ minLength: 1, maxLength: 120 }),
		description: Type.String({ minLength: 1, maxLength: 1_024 }),
		instructions: Type.Optional(Type.String({ maxLength: 1_000_000 })),
		scope: Type.Union([Type.Literal("global"), Type.Literal("project")]),
		projectId: Type.Optional(Type.String()),
	},
	{ additionalProperties: false },
);

export const CommitSkillImportSchema = Type.Object(
	{ slugs: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 256 }) },
	{ additionalProperties: false },
);

export const SaveSkillContentSchema = Type.Object(
	{
		content: Type.String({ minLength: 1, maxLength: 1_000_000 }),
		expectedHash: Type.String({ minLength: 1 }),
	},
	{ additionalProperties: false },
);

export type CreateSkillImportRequest = Static<typeof CreateSkillImportSchema>;
export type CreateSkillRequest = Static<typeof CreateSkillSchema>;
export type CommitSkillImportRequest = Static<typeof CommitSkillImportSchema>;
export type SaveSkillContentRequest = Static<typeof SaveSkillContentSchema>;
