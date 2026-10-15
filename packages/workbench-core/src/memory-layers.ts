/** Function, scope and modality are independent dimensions. History remains in Pi JSONL. */
export type MemoryLayer = "working" | "episodic" | "semantic" | "perceptual";
export type MemoryScopeType = "personal" | "global" | "project" | "session";
export type MemoryModality = "text" | "image" | "audio" | "document";
export type MemoryOrigin = "original" | "model" | "user";
export type MemoryConfirmation = "unknown" | "unverified" | "verified" | "user_confirmed";

export interface MemoryEvidence {
	kind: "message" | "tool" | "artifact" | "document" | "file";
	id: string;
	sessionId?: string;
	runId?: string;
	piEntryId?: string;
	toolCallId?: string;
	path?: string;
	excerpt?: string;
	confirmation: MemoryConfirmation;
	availability: "present" | "missing" | "retained_excerpt";
}

export interface WorkingCheckpoint {
	confidence?: number;
	review?: { status: "queued" | "running" | "complete" | "failed" | "interrupted"; error?: string };
	sessionId: string;
	projectId?: string;
	taskId?: string;
	runId?: string;
	branchId?: string;
	sourceSequence: number;
	goal: string;
	completedSteps: string[];
	nextSteps: string[];
	constraints: string[];
	temporaryConclusions: Array<{ text: string; confirmation: MemoryConfirmation }>;
	unresolvedQuestions: string[];
	sources: MemoryEvidence[];
	status: "running" | "completed" | "failed" | "cancelled" | "interrupted";
	version: number;
	updatedAt: string;
	expiresAt: string;
}

export interface EpisodicMemory {
	confidence?: number;
	id: string;
	projectId?: string;
	sessionId: string;
	runId: string;
	taskId?: string;
	occurredAt: string;
	summary: string;
	actions: Array<{ tool: string; result: string; verified: boolean; toolCallId?: string }>;
	result: string;
	outcome: "success" | "failure" | "cancelled" | "unverified" | "interrupted";
	sources: MemoryEvidence[];
	semanticIds: string[];
	skillIds: string[];
	retention: "keep" | "until";
	expiresAt?: string;
	version: number;
	updatedAt: string;
}

export interface MemoryContextFragment {
	timestamp?: string;
	confidence?: number;
	id: string;
	layer: MemoryLayer | "skill";
	label: string;
	text: string;
	reason: string;
	sources: MemoryEvidence[];
	version?: number;
	truncated: boolean;
	/** User-authored conventions are instructions, not claims strengthened by evidence scores. */
	instruction?: { scope: MemoryScopeType; subjects: string[] };
}

export interface MemoryRetrievalRequest {
	sessionId: string;
	projectId?: string;
	query: string;
	from?: string;
	until?: string;
	budget?: number;
	limits?: Partial<Record<MemoryLayer | "skill", number>>;
	signal?: AbortSignal;
}

export interface MemoryRetrievalResult {
	fragments: MemoryContextFragment[];
	diagnostics: string[];
	characters: number;
	estimatedTokens: number;
	elapsedMs: number;
}

export interface ContextAssemblyResult extends MemoryRetrievalResult {
	loadedSkills?: Array<{ path: string; hash: string; method: "invocation" | "read" }>;
	systemPromptCharacters?: number;
	baseSources?: Array<{ label: string; text: string; characters: number }>;
	sessionId: string;
	projectId?: string;
	runId: string;
	request: number;
	createdAt: string;
}

export interface EpisodeQuery {
	minConfidence?: number;
	projectId?: string;
	sessionId?: string;
	taskId?: string;
	query?: string;
	from?: string;
	until?: string;
	limit?: number;
}

export interface MemoryStateRepository {
	getCheckpoint(sessionId: string): Promise<WorkingCheckpoint | undefined>;
	saveCheckpoint(value: WorkingCheckpoint, expectedVersion: number): Promise<WorkingCheckpoint | undefined>;
	interruptRunning(at: string): Promise<number>;
	interruptedCheckpoints(): Promise<WorkingCheckpoint[]>;
	cleanupExpired(at: string): Promise<number>;
	getEpisode(id: string): Promise<EpisodicMemory | undefined>;
	getRunEpisode(runId: string): Promise<EpisodicMemory | undefined>;
	saveEpisode(value: EpisodicMemory): Promise<EpisodicMemory>;
	updateEpisode(value: EpisodicMemory, expectedVersion: number): Promise<boolean>;
	queryEpisodes(query: EpisodeQuery): Promise<EpisodicMemory[]>;
	hasEpisodeVectors(query: EpisodeQuery): Promise<boolean>;
	saveEpisodeVector(id: string, version: number, space: string, vector: number[]): Promise<void>;
	searchEpisodeVectors(query: EpisodeQuery, space: string, vector: number[]): Promise<EpisodicMemory[]>;
	deleteEpisode(id: string): Promise<boolean>;
	saveContext(value: ContextAssemblyResult): Promise<void>;
	getContext(sessionId: string): Promise<ContextAssemblyResult | undefined>;
}
