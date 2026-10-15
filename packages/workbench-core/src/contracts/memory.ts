import { Type } from "typebox";

export const SemanticChangeSchema = Type.Object(
	{
		confidence: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
		operation: Type.Union([
			Type.Literal("create"),
			Type.Literal("update"),
			Type.Literal("merge"),
			Type.Literal("supersede"),
			Type.Literal("invalidate"),
			Type.Literal("rollback"),
		]),
		targetId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
		expectedVersion: Type.Optional(Type.Integer({ minimum: 1 })),
		mergeIds: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { maxItems: 20 })),
		rollbackVersion: Type.Optional(Type.Integer({ minimum: 1 })),
		validFrom: Type.Optional(Type.String({ format: "date-time" })),
		validUntil: Type.Optional(Type.String({ format: "date-time" })),
	},
	{ additionalProperties: false },
);

export type {
	ContextAssemblyResult,
	EpisodicMemory,
	MemoryContextFragment,
	MemoryEvidence,
	MemoryRetrievalResult,
	WorkingCheckpoint,
} from "../memory-layers.ts";
export type { SemanticChange, SemanticMemory, SemanticOperation } from "../semantic-memory.ts";
