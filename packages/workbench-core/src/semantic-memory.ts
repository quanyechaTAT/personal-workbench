import type { MemoryConfirmation, MemoryEvidence, MemoryOrigin } from "./memory-layers.ts";
import type { MemoryKind } from "./models.ts";

export type SemanticOperation = "create" | "update" | "merge" | "supersede" | "invalidate" | "rollback";
export interface SemanticChange {
	operation: SemanticOperation;
	targetId?: string;
	expectedVersion?: number;
	mergeIds?: string[];
	rollbackVersion?: number;
	evidence?: MemoryEvidence[];
	validFrom?: string;
	validUntil?: string;
	duplicateIds?: string[];
	conflictIds?: string[];
}
export interface SemanticMemory {
	/** Index-only fingerprint of the last observed Markdown anchor and body. */
	externalHash?: string;
	id: string;
	kind: Exclude<MemoryKind, "daily">;
	projectId?: string;
	relativePath: string;
	text: string;
	heading?: string;
	version: number;
	origin: MemoryOrigin;
	confirmation: MemoryConfirmation;
	evidence: MemoryEvidence[];
	validFrom: string;
	validUntil?: string;
	status: "active" | "superseded" | "invalidated";
	supersedes?: string;
	supersededBy?: string;
	conflict: "none" | "detected" | "external_edit";
	contentHash: string;
	updatedAt: string;
	startLine: number;
	endLine: number;
}
export interface MemoryWriteIntent {
	id: string;
	kind: MemoryKind;
	projectId?: string;
	relativePath: string;
	candidateId?: string;
	before: string | null;
	after: string | null;
	beforeHash: string | null;
	afterHash: string | null;
	status: "prepared" | "applied" | "conflicted";
	createdAt: string;
}
export interface SemanticQuery {
	projectId?: string;
	kind?: Exclude<MemoryKind, "daily">;
	query?: string;
	activeOnly?: boolean;
	at: string;
	limit?: number;
}
export interface SemanticEmbeddingPort {
	fingerprint(): Promise<string | undefined>;
	embed(text: string, signal?: AbortSignal): Promise<{ vector: number[]; fingerprint: string }>;
}
export interface SemanticRepository {
	saveWriteIntent(value: MemoryWriteIntent): Promise<void>;
	listWriteIntents(): Promise<MemoryWriteIntent[]>;
	finishWriteIntent(id: string, status: "applied" | "conflicted"): Promise<void>;
	replaceSemantics(path: string, values: SemanticMemory[]): Promise<void>;
	relocateProjectFile(projectId: string, from: string, to: string): Promise<void>;
	getSemantic(id: string): Promise<SemanticMemory | undefined>;
	listSemantics(query: SemanticQuery): Promise<SemanticMemory[]>;
	semanticHistory(id: string): Promise<SemanticMemory[]>;
	saveSemanticVector(id: string, version: number, fingerprint: string, vector: number[]): Promise<void>;
	searchSemanticVectors(query: SemanticQuery, fingerprint: string, vector: number[]): Promise<SemanticMemory[]>;
}
