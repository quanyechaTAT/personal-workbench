/** Project files are the source of truth; these records are disposable retrieval indexes. */
export interface KnowledgeFileRecord {
	projectId: string;
	path: string;
	contentHash: string;
	modelFingerprint: string;
	chunkCount: number;
	indexedAt: string;
	indexFingerprint?: string;
	parserFingerprint?: string;
	chunkerFingerprint?: string;
	tokenizerFingerprint?: string;
}

export interface KnowledgeSource {
	reviewedAt?: string;
	kind: "text" | "pdf" | "docx" | "doc" | "ocr" | "transcript" | "description" | "image";
	representation?: "original_text" | "ocr" | "transcript" | "model_description" | "original_image";
	origin?: "original" | "model";
	region?: {
		centerX: number;
		centerY: number;
		width: number;
		height: number;
		angle: number;
		imageWidth: number;
		imageHeight: number;
	};
	beginMs?: number;
	endMs?: number;
	speaker?: string;
	modelFingerprint?: string;
	markdownStart: number;
	markdownEnd: number;
	page?: number;
	startLine?: number;
	endLine?: number;
	originalStart?: number;
	originalEnd?: number;
	block?: number;
	textItemStart?: number;
	textItemEnd?: number;
}

export interface KnowledgePassage {
	overlap?: { tokenCount: number; sources: KnowledgeSource[] };
	text: string;
	startPage?: number;
	endPage?: number;
	headingPath?: string[];
	sources?: KnowledgeSource[];
	tokenCount?: number;
	markdownStart?: number;
	markdownEnd?: number;
}

export interface KnowledgeChunk extends KnowledgePassage {
	id?: string;
	projectId: string;
	path: string;
	ordinal: number;
	text: string;
	vector: number[];
	startPage?: number;
	endPage?: number;
}

export interface KnowledgeHit extends KnowledgePassage {
	id?: string;
	path: string;
	chunk: number;
	score: number;
	text: string;
	documentId?: string;
	name?: string;
	startPage?: number;
	endPage?: number;
	sourcePath?: string;
	matches?: Array<{ query: string; method: "vector" | "keyword" | "hyde"; rank: number }>;
}

export interface KnowledgeDerivedDocument {
	projectId: string;
	path: string;
	markdown: string;
	sources: KnowledgeSource[];
	diagnostics: string[];
	parserFingerprint: string;
	contentHash: string;
}

export interface KnowledgeSettings {
	overlapTokens?: number;
	maxChunkTokens: number;
	minChunkTokens: number;
	contextTokens: number;
	queryTokens: number;
	mqe: "off" | "auto" | "always";
	mqeTimeoutMs: number;
	hyde?: "off" | "auto" | "always";
	hydeTimeoutMs?: number;
	hydeTokens?: number;
}

export interface KnowledgeHydeTrace {
	mode: "off" | "auto" | "always";
	applied: boolean;
	reason: string;
	model?: { provider: string; modelId: string };
	document?: string;
	tokenCount?: number;
}

export interface KnowledgeSearchResult {
	queries: string[];
	hits: KnowledgeHit[];
	context: string;
	contextTokens: number;
	tokenizer?: string;
	mqe: { mode: KnowledgeSettings["mqe"]; applied: boolean; reason: string };
	hyde?: KnowledgeHydeTrace;
	diagnostics: string[];
	elapsedMs: number;
}

export interface KnowledgeDocument {
	descriptionReview?: { fingerprint: string; reviewedAt: string };
	describeScans?: boolean;
	perceptionFingerprint?: string;
	contentVersion?: number;
	source?: { kind: "upload" | "snapshot"; path?: string; indexed?: boolean };
	supersededBy?: string;
	processingStage?: "ocr" | "transcribing" | "describing" | "embedding";
	processingState?: "partial" | "missing_capability" | "cancelled" | "interrupted" | "stale";
	progress?: { completed: number; total: number };
	id: string;
	projectId: string;
	name: string;
	path: string;
	mimeType: string;
	size: number;
	sha256: string;
	status: "queued" | "processing" | "ready" | "failed";
	stage: "queued" | "parsing" | "embedding" | "ready" | "failed";
	chunkCount: number;
	processedChunks: number;
	pageCount?: number;
	error?: string;
	createdAt: string;
	updatedAt: string;
	diagnostics?: string[];
}

export interface KnowledgeStatus {
	capabilities?: Array<{ name: string; configured: boolean; model: string; diagnostic?: string }>;
	configured: boolean;
	model?: string;
	fileCount: number;
	chunkCount: number;
	indexedAt?: string;
	diagnostic?: string;
	vectorEngine: "sqlite-vec";
	documentCount: number;
	processingCount: number;
	failedCount: number;
	settings?: KnowledgeSettings;
	tokenizer?: string;
	staleFileCount?: number;
}

export interface KnowledgeRepository {
	documentReferenceCount(projectId: string, documentId: string): Promise<number>;
	listRepresentations(projectId: string, documentId: string): Promise<PerceptualRepresentation[]>;
	saveRepresentation(value: PerceptualRepresentation): Promise<void>;
	replacePerceptualVectors(projectId: string, documentId: string, values: PerceptualVector[]): Promise<void>;
	searchPerceptualVectors(
		projectId: string,
		spaceId: string,
		vector: number[],
		limit: number,
	): Promise<KnowledgeHit[]>;
	listFiles(projectId: string): Promise<KnowledgeFileRecord[]>;
	listChunks(projectId: string): Promise<KnowledgeChunk[]>;
	replaceFile(file: KnowledgeFileRecord, chunks: KnowledgeChunk[]): Promise<void>;
	deleteFile(projectId: string, path: string): Promise<void>;
	search(
		projectId: string,
		fingerprint: string,
		vector: number[],
		limit: number,
		indexFingerprint?: string,
	): Promise<KnowledgeHit[]>;
	searchKeywords(
		projectId: string,
		indexFingerprint: string | undefined,
		query: string,
		limit: number,
	): Promise<KnowledgeHit[]>;
	getSettings(projectId: string): Promise<KnowledgeSettings | undefined>;
	saveSettings(projectId: string, settings: KnowledgeSettings): Promise<void>;
	saveDerived(document: KnowledgeDerivedDocument): Promise<void>;
	getDerived(projectId: string, path: string): Promise<KnowledgeDerivedDocument | undefined>;
	listDocuments(projectId?: string): Promise<KnowledgeDocument[]>;
	getDocument(projectId: string, id: string): Promise<KnowledgeDocument | undefined>;
	saveDocument(document: KnowledgeDocument): Promise<void>;
	deleteDocument(projectId: string, id: string): Promise<void>;
}

export interface PerceptualRepresentation {
	id: string;
	projectId: string;
	documentId: string;
	contentVersion: number;
	contentHash: string;
	ordinal: number;
	kind: "ocr" | "transcript" | "model_description";
	text: string;
	sources: KnowledgeSource[];
	modelFingerprint: string;
	createdAt: string;
}
export interface PerceptualVector {
	id: string;
	projectId: string;
	documentId: string;
	contentVersion: number;
	spaceId: string;
	vector: number[];
	text: string;
	sources: KnowledgeSource[];
}
