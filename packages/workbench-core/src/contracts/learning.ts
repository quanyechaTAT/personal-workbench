import { type Static, Type } from "typebox";
import type { WorkbenchSkill } from "../models.ts";
import type { SemanticMemory } from "../semantic-memory.ts";
import { SemanticChangeSchema } from "./memory.ts";

export const LearningModeSchema = Type.Literal("auto");
export const LearningEvidenceSchema = Type.Object(
	{
		sourceId: Type.String({ minLength: 1, description: "An exact source ID returned by learning_context." }),
		quote: Type.String({
			minLength: 4,
			maxLength: 500,
			description:
				"Copy a continuous verbatim substring from sources.text. Do not add labels, paraphrase or quote context not in that source.",
		}),
	},
	{ additionalProperties: false },
);
const EvidenceSchema = LearningEvidenceSchema;
export const LearningMemorySchema = Type.Object(
	{
		text: Type.String({ minLength: 1, maxLength: 1000 }),
		category: Type.Optional(
			Type.Union(
				[Type.Literal("fact"), Type.Literal("preference"), Type.Literal("environment"), Type.Literal("decision")],
				{
					description:
						"preference: explicit durable user habits/interaction requirements, saved to the Workbench data root USER.md, shared by all projects. fact/environment/decision: project/tool knowledge, saved to project AGENTS.md.",
				},
			),
		),
		futureUse: Type.Optional(Type.String({ minLength: 8, maxLength: 300 })),
		change: Type.Optional(SemanticChangeSchema),
		evidence: Type.Array(EvidenceSchema, { minItems: 1, maxItems: 3 }),
	},
	{ additionalProperties: false },
);
export const LearningSkillSchema = Type.Object(
	{
		slug: Type.String({ pattern: "^learned-[a-z0-9]+(?:-[a-z0-9]+)*$", maxLength: 64 }),
		title: Type.String({ minLength: 1, maxLength: 100 }),
		description: Type.String({ minLength: 1, maxLength: 500 }),
		instructions: Type.String({
			minLength: 1,
			maxLength: 8000,
			description:
				"Reusable method with sections ## 适用条件, ## 步骤 and ## 验证 (or equivalent clear headings). Parameterize input/output, do not store task answers or a session narrative. For a preference patch retain the existing verified body.",
		}),
		targetId: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
		baseHash: Type.Optional(Type.String({ pattern: "^[a-f0-9]{64}$" })),
		intent: Type.Optional(Type.Union([Type.Literal("procedure"), Type.Literal("preference")])),
		patch: Type.Optional(
			Type.Object(
				{
					oldText: Type.String({ minLength: 4, maxLength: 2000 }),
					newText: Type.String({ minLength: 4, maxLength: 2000 }),
				},
				{ additionalProperties: false },
			),
		),
		recoveredFailures: Type.Optional(Type.Array(EvidenceSchema, { maxItems: 8 })),
		evidence: Type.Array(EvidenceSchema, { minItems: 1, maxItems: 3 }),
	},
	{ additionalProperties: false },
);
const CheckpointItemSchema = Type.Object(
	{
		text: Type.String({ minLength: 1, maxLength: 600 }),
		evidence: Type.Array(EvidenceSchema, { minItems: 1, maxItems: 3 }),
	},
	{ additionalProperties: false },
);
export const WorkingSummarySchema = Type.Object(
	{
		goal: Type.Optional(CheckpointItemSchema),
		completedSteps: Type.Array(CheckpointItemSchema, { maxItems: 8 }),
		nextSteps: Type.Array(CheckpointItemSchema, { maxItems: 5 }),
		constraints: Type.Array(CheckpointItemSchema, { maxItems: 8 }),
		unresolvedQuestions: Type.Array(CheckpointItemSchema, { maxItems: 8 }),
		temporaryConclusions: Type.Array(CheckpointItemSchema, { maxItems: 3 }),
	},
	{ additionalProperties: false },
);
export type WorkingSummaryOutput = Static<typeof WorkingSummarySchema>;
export const LearningOutputSchema = Type.Object(
	{
		checkpoint: Type.Optional(WorkingSummarySchema),
		summary: Type.String({ maxLength: 1000 }),
		memories: Type.Array(LearningMemorySchema, { maxItems: 3 }),
		skills: Type.Array(LearningSkillSchema, { maxItems: 2 }),
	},
	{ additionalProperties: false },
);
export type LearningMode = Static<typeof LearningModeSchema>;
export type LearningOutput = Static<typeof LearningOutputSchema>;
export type LearningEvidence = Static<typeof EvidenceSchema>;
export interface ProjectLearningSettings {
	mode: LearningMode;
	memoryInterval: number;
	skillInterval: number;
}
export interface LearningRunReference {
	id: string;
	startedAt: string;
	settledAt: string;
	verified: boolean;
	iterations: number;
}
export interface LearningCadence {
	sessionId: string;
	projectId: string;
	turns: number;
	iterations: number;
	runs: LearningRunReference[];
	updatedAt: string;
}
export type LearningReviewStatus = "queued" | "running" | "ready" | "empty" | "failed" | "interrupted" | "cancelled";
export type LearningChangeStatus =
	| "pending"
	| "applying"
	| "applied"
	| "rejected"
	| "conflicted"
	| "rolling_back"
	| "rolled_back";
export interface LearningDiagnostic {
	kind: "memory" | "skill" | "checkpoint";
	index: number;
	message: string;
}
export interface LearningSkillState {
	skillId: string;
	projectId: string;
	reviewId?: string;
	changeId?: string;
	version: number;
	contentHash: string;
	manifestHash: string;
	status: "managed" | "detached" | "rolled_back";
	updatedAt: string;
}
export interface LearningSkillUse {
	projectId: string;
	sessionId: string;
	runId: string;
	skillId: string;
	contentHash: string;
	version?: number;
	method: "invocation" | "read";
	loadedAt: string;
	validatedAt?: string;
}
export interface LearningExperiences {
	facts: SemanticMemory[];
	skills: Array<{ skill: WorkbenchSkill; title: string; management?: LearningSkillState; uses: LearningSkillUse[] }>;
}
export interface LearningChange {
	operation?: "create" | "update" | "merge" | "supersede" | "invalidate" | "rollback";
	targetId?: string;
	baseVersion?: number;
	baseHash?: string;
	memory?: LearningOutput["memories"][number];
	promotionKey?: string;
	semanticIds?: string[];
	verifiedRunIds?: string[];
	autoBlockedReason?: string;
	id: string;
	kind: "memory" | "skill";
	title: string;
	relativePath: string;
	skill?: LearningOutput["skills"][number];
	skillId?: string;
	before: string | null;
	after: string;
	status: LearningChangeStatus;
	evidence: LearningEvidence[];
	error?: string;
}
export interface LearningReview {
	origin?: "agent" | "periodic" | "prompt" | "manual";
	snapshotKey?: string;
	sourceRunIds?: string[];
	manual?: boolean;
	diagnostics?: LearningDiagnostic[];
	id: string;
	projectId: string;
	sessionId: string;
	sourceKey: string;
	sourceRunId?: string;
	model?: { provider: string; modelId: string };
	status: LearningReviewStatus;
	mode: LearningMode;
	summary: string;
	changes: LearningChange[];
	usage?: { input: number; output: number; total: number };
	version: number;
	createdAt: string;
	updatedAt: string;
	error?: string;
}
