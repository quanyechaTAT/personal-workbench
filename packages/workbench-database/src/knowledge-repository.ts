import type {
	KnowledgeChunk,
	KnowledgeDerivedDocument,
	KnowledgeDocument,
	KnowledgeFileRecord,
	KnowledgeHit,
	KnowledgePassage,
	KnowledgeRepository,
	KnowledgeSettings,
	PerceptualRepresentation,
	PerceptualVector,
} from "@earendil-works/workbench-core";
import { WorkbenchError } from "@earendil-works/workbench-core";
import type { WorkbenchDatabase } from "./database.ts";

interface FileRow {
	project_id: string;
	path: string;
	content_hash: string;
	model_fingerprint: string;
	chunk_count: number;
	indexed_at: string;
	index_fingerprint: string;
	parser_fingerprint: string;
	chunker_fingerprint: string;
	tokenizer_fingerprint: string;
}
interface ChunkRow {
	id: number;
	project_id: string;
	path: string;
	ordinal: number;
	text: string;
	vector_json: string;
	dimension: number;
	start_page: number | null;
	end_page: number | null;
	stable_id: string | null;
	metadata_json: string;
}
interface DocumentRow {
	id: string;
	project_id: string;
	name: string;
	path: string;
	mime_type: string;
	size: number;
	sha256: string;
	status: KnowledgeDocument["status"];
	stage: KnowledgeDocument["stage"];
	chunk_count: number;
	processed_chunks: number;
	page_count: number | null;
	error: string | null;
	created_at: string;
	updated_at: string;
	diagnostics_json: string;
	data_json: string;
}

/** Space-separated Latin terms and Han bigrams make SQLite unicode61 useful for Chinese. */
export function knowledgeTerms(text: string, limit?: number): string[] {
	const terms: string[] = [];
	for (const match of text.toLowerCase().matchAll(/[\p{Script=Han}]+|[\p{L}\p{N}_]+/gu)) {
		const value = match[0];
		if (/\p{Script=Han}/u.test(value) && value.length > 1) {
			const chars = Array.from(value);
			for (let i = 0; i < chars.length - 1; i++) terms.push(chars[i] + chars[i + 1]);
		} else terms.push(value);
	}
	const unique = [...new Set(terms)];
	if (limit === undefined || unique.length <= limit) return unique;
	const bounded = Math.max(2, Math.floor(limit));
	// Index every source term; bounded queries cover both the beginning and the final subject.
	return Array.from(
		{ length: bounded },
		(_, index) => unique[Math.round((index * (unique.length - 1)) / (bounded - 1))],
	);
}

function passage(row: ChunkRow): KnowledgePassage {
	return {
		...(JSON.parse(row.metadata_json) as KnowledgePassage),
		text: row.text,
		startPage: row.start_page ?? undefined,
		endPage: row.end_page ?? undefined,
	};
}

function hit(row: ChunkRow, score: number): KnowledgeHit {
	return {
		...passage(row),
		id: row.stable_id ?? `${row.project_id}:${row.path}:${row.ordinal}`,
		path: row.path,
		chunk: row.ordinal,
		score,
	};
}
function vectorTable(dimension: number): string {
	if (!Number.isInteger(dimension) || dimension < 1 || dimension > 8192)
		throw new WorkbenchError("invalid_input", "Embedding 向量维度无效");
	return `knowledge_vec_${dimension}`;
}
function document(row: DocumentRow): KnowledgeDocument {
	return {
		...(JSON.parse(row.data_json) as Partial<KnowledgeDocument>),
		id: row.id,
		projectId: row.project_id,
		name: row.name,
		path: row.path,
		mimeType: row.mime_type,
		size: row.size,
		sha256: row.sha256,
		status: row.status,
		stage: row.stage,
		chunkCount: row.chunk_count,
		processedChunks: row.processed_chunks,
		pageCount: row.page_count ?? undefined,
		error: row.error ?? undefined,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		diagnostics: JSON.parse(row.diagnostics_json) as string[],
	};
}
/** Metadata, passages and vec0 vectors share one SQLite transaction. */
export class SqliteKnowledgeRepository implements KnowledgeRepository {
	private readonly database: WorkbenchDatabase;
	constructor(database: WorkbenchDatabase) {
		this.database = database;
		const legacy = this.database
			.prepare(
				`SELECT c.rowid AS id, c.*, f.model_fingerprint FROM knowledge_chunks c JOIN knowledge_files f USING(project_id,path) WHERE c.dimension = 0 AND c.vector_json != '[]'`,
			)
			.all() as unknown as Array<ChunkRow & { model_fingerprint: string }>;
		if (legacy.length)
			this.database.transaction(() => {
				for (const row of legacy) {
					const value: unknown = JSON.parse(row.vector_json);
					if (
						!Array.isArray(value) ||
						!value.length ||
						!value.every((entry: unknown) => typeof entry === "number" && Number.isFinite(entry))
					)
						throw new WorkbenchError("storage_failure", "旧知识向量索引损坏，请重新建立索引");
					this.insertVector(row.id, row.project_id, row.model_fingerprint, value);
					this.database
						.prepare("UPDATE knowledge_chunks SET dimension = ?, vector_json = '[]' WHERE rowid = ?")
						.run(value.length, row.id);
				}
			});
	}
	private ensureTable(dimension: number): string {
		const table = vectorTable(dimension);
		this.database.exec(
			`CREATE VIRTUAL TABLE IF NOT EXISTS ${table} USING vec0(chunk_id INTEGER PRIMARY KEY, project_id TEXT PARTITION KEY, model_hash TEXT, embedding FLOAT[${dimension}] distance_metric=cosine)`,
		);
		this.database.prepare("INSERT OR IGNORE INTO knowledge_vector_dimensions(dimension) VALUES (?)").run(dimension);
		return table;
	}
	private insertVector(id: number | bigint, projectId: string, fingerprint: string, vector: number[]): void {
		const table = this.ensureTable(vector.length);
		this.database
			.prepare(`INSERT INTO ${table}(chunk_id,project_id,model_hash,embedding) VALUES (?,?,?,?)`)
			.run(BigInt(id), projectId, fingerprint, new Uint8Array(new Float32Array(vector).buffer));
	}
	private removeFile(projectId: string, path: string): void {
		const rows = this.database
			.prepare("SELECT rowid AS id,dimension FROM knowledge_chunks WHERE project_id = ? AND path = ?")
			.all(projectId, path) as unknown as Array<{ id: number; dimension: number }>;
		for (const row of rows)
			if (row.dimension > 0)
				this.database.prepare(`DELETE FROM ${vectorTable(row.dimension)} WHERE chunk_id = ?`).run(BigInt(row.id));
		for (const row of rows)
			this.database
				.prepare("DELETE FROM knowledge_keywords WHERE chunk_id = ? AND project_id = ?")
				.run(row.id, projectId);
		this.database.prepare("DELETE FROM knowledge_files WHERE project_id = ? AND path = ?").run(projectId, path);
	}
	async listFiles(projectId: string): Promise<KnowledgeFileRecord[]> {
		const rows = this.database
			.prepare("SELECT * FROM knowledge_files WHERE project_id = ? ORDER BY path")
			.all(projectId) as unknown as FileRow[];
		return rows.map((row) => ({
			projectId: row.project_id,
			path: row.path,
			contentHash: row.content_hash,
			modelFingerprint: row.model_fingerprint,
			chunkCount: row.chunk_count,
			indexedAt: row.indexed_at,
			indexFingerprint: row.index_fingerprint,
			parserFingerprint: row.parser_fingerprint,
			chunkerFingerprint: row.chunker_fingerprint,
			tokenizerFingerprint: row.tokenizer_fingerprint,
		}));
	}
	async listChunks(projectId: string): Promise<KnowledgeChunk[]> {
		const rows = this.database
			.prepare("SELECT rowid AS id,* FROM knowledge_chunks WHERE project_id = ? ORDER BY path,ordinal")
			.all(projectId) as unknown as ChunkRow[];
		return rows.map((row) => ({
			...passage(row),
			id: row.stable_id ?? undefined,
			projectId: row.project_id,
			path: row.path,
			ordinal: row.ordinal,
			text: row.text,
			vector: [],
			startPage: row.start_page ?? undefined,
			endPage: row.end_page ?? undefined,
		}));
	}
	async replaceFile(file: KnowledgeFileRecord, chunks: KnowledgeChunk[]): Promise<void> {
		this.database.transaction(() => {
			this.removeFile(file.projectId, file.path);
			this.database
				.prepare(
					"INSERT INTO knowledge_files(project_id,path,content_hash,model_fingerprint,chunk_count,indexed_at,index_fingerprint,parser_fingerprint,chunker_fingerprint,tokenizer_fingerprint) VALUES (?,?,?,?,?,?,?,?,?,?)",
				)
				.run(
					file.projectId,
					file.path,
					file.contentHash,
					file.modelFingerprint,
					file.chunkCount,
					file.indexedAt,
					file.indexFingerprint ?? "",
					file.parserFingerprint ?? "",
					file.chunkerFingerprint ?? "",
					file.tokenizerFingerprint ?? "",
				);
			const insert = this.database.prepare(
				"INSERT INTO knowledge_chunks(project_id,path,ordinal,text,vector_json,dimension,start_page,end_page,stable_id,metadata_json) VALUES (?,?,?,?,'[]',?,?,?,?,?)",
			);
			for (const chunk of chunks) {
				const row = insert.run(
					chunk.projectId,
					chunk.path,
					chunk.ordinal,
					chunk.text,
					chunk.vector.length,
					chunk.startPage ?? null,
					chunk.endPage ?? null,
					chunk.id ?? null,
					JSON.stringify({
						overlap: chunk.overlap,
						headingPath: chunk.headingPath,
						sources: chunk.sources,
						tokenCount: chunk.tokenCount,
						markdownStart: chunk.markdownStart,
						markdownEnd: chunk.markdownEnd,
					}),
				);
				if (chunk.vector.length)
					this.insertVector(
						row.lastInsertRowid,
						chunk.projectId,
						file.indexFingerprint || file.modelFingerprint,
						chunk.vector,
					);
				this.database
					.prepare("INSERT INTO knowledge_keywords(chunk_id,project_id,terms) VALUES (?,?,?)")
					.run(row.lastInsertRowid, chunk.projectId, knowledgeTerms(chunk.text).join(" "));
			}
		});
	}
	async deleteFile(projectId: string, path: string): Promise<void> {
		this.database.transaction(() => this.removeFile(projectId, path));
	}
	async search(
		projectId: string,
		fingerprint: string,
		vector: number[],
		limit: number,
		indexFingerprint?: string,
	): Promise<KnowledgeHit[]> {
		const dimension = vector.length;
		const dimensions = this.database
			.prepare(
				"SELECT DISTINCT c.dimension FROM knowledge_chunks c JOIN knowledge_files f USING(project_id,path) LEFT JOIN knowledge_documents d ON d.project_id=c.project_id AND d.path=c.path WHERE c.project_id = ? AND f.model_fingerprint = ? AND (? IS NULL OR f.index_fingerprint = ?) AND (d.id IS NULL OR (d.status='ready' AND json_extract(d.data_json,'$.supersededBy') IS NULL AND COALESCE(json_extract(d.data_json,'$.processingState'),'')!='stale'))",
			)
			.all(projectId, fingerprint, indexFingerprint ?? null, indexFingerprint ?? null) as unknown as Array<{
			dimension: number;
		}>;
		if (dimensions.some((row) => row.dimension !== dimension))
			throw new WorkbenchError("conflict", "Embedding 服务返回的向量维度与项目索引不同，请重新建立索引");
		if (!this.database.prepare("SELECT 1 FROM knowledge_vector_dimensions WHERE dimension = ?").get(dimension))
			return [];
		const matches = this.database
			.prepare(
				`SELECT chunk_id,distance FROM ${vectorTable(dimension)} WHERE embedding MATCH ? AND k = ? AND project_id = ? AND model_hash = ? AND chunk_id IN (SELECT c.rowid FROM knowledge_chunks c JOIN knowledge_files f USING(project_id,path) LEFT JOIN knowledge_documents d ON d.project_id=c.project_id AND d.path=c.path WHERE c.project_id=? AND f.model_fingerprint=? AND (? IS NULL OR f.index_fingerprint=?) AND (d.id IS NULL OR (d.status='ready' AND json_extract(d.data_json,'$.supersededBy') IS NULL AND COALESCE(json_extract(d.data_json,'$.processingState'),'')!='stale'))) ORDER BY distance`,
			)
			.all(
				new Uint8Array(new Float32Array(vector).buffer),
				BigInt(limit),
				projectId,
				indexFingerprint ?? fingerprint,
				projectId,
				fingerprint,
				indexFingerprint ?? null,
				indexFingerprint ?? null,
			) as unknown as Array<{ chunk_id: number; distance: number }>;
		return matches.flatMap((match) => {
			const row = this.database
				.prepare("SELECT rowid AS id,* FROM knowledge_chunks WHERE rowid = ? AND project_id = ?")
				.get(match.chunk_id, projectId) as unknown as ChunkRow | undefined;
			return row ? [hit(row, Math.max(-1, Math.min(1, 1 - match.distance)))] : [];
		});
	}
	async searchKeywords(
		projectId: string,
		indexFingerprint: string | undefined,
		query: string,
		limit: number,
	): Promise<KnowledgeHit[]> {
		const terms = knowledgeTerms(query, 32);
		if (!terms.length) return [];
		const expression = terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(" OR ");
		const rows = this.database
			.prepare(
				`SELECT c.rowid AS id,c.*,bm25(knowledge_keywords) AS rank FROM knowledge_keywords JOIN knowledge_chunks c ON c.rowid = knowledge_keywords.chunk_id JOIN knowledge_files f ON f.project_id = c.project_id AND f.path = c.path LEFT JOIN knowledge_documents d ON d.project_id = c.project_id AND d.path = c.path WHERE knowledge_keywords MATCH ? AND knowledge_keywords.project_id = ? AND c.project_id = ? AND (? IS NULL OR f.index_fingerprint = ?) AND (d.id IS NULL OR (d.status = 'ready' AND json_extract(d.data_json,'$.supersededBy') IS NULL AND COALESCE(json_extract(d.data_json,'$.processingState'),'') != 'stale')) ORDER BY rank,c.stable_id,c.path,c.ordinal LIMIT ?`,
			)
			.all(
				expression,
				projectId,
				projectId,
				indexFingerprint ?? null,
				indexFingerprint ?? null,
				limit,
			) as unknown as Array<ChunkRow & { rank: number }>;
		return rows.map((row) => hit(row, -row.rank));
	}
	async getSettings(projectId: string): Promise<KnowledgeSettings | undefined> {
		const row = this.database
			.prepare("SELECT settings_json FROM knowledge_settings WHERE project_id = ?")
			.get(projectId);
		return row ? (JSON.parse(String(row.settings_json)) as KnowledgeSettings) : undefined;
	}
	async saveSettings(projectId: string, settings: KnowledgeSettings): Promise<void> {
		this.database
			.prepare(
				"INSERT INTO knowledge_settings VALUES(?,?) ON CONFLICT(project_id) DO UPDATE SET settings_json=excluded.settings_json",
			)
			.run(projectId, JSON.stringify(settings));
	}
	async saveDerived(value: KnowledgeDerivedDocument): Promise<void> {
		this.database
			.prepare(
				"INSERT INTO knowledge_derivatives VALUES(?,?,?,?,?,?,?) ON CONFLICT(project_id,path) DO UPDATE SET markdown=excluded.markdown,sources_json=excluded.sources_json,diagnostics_json=excluded.diagnostics_json,parser_fingerprint=excluded.parser_fingerprint,content_hash=excluded.content_hash",
			)
			.run(
				value.projectId,
				value.path,
				value.markdown,
				JSON.stringify(value.sources),
				JSON.stringify(value.diagnostics),
				value.parserFingerprint,
				value.contentHash,
			);
	}
	async getDerived(projectId: string, path: string): Promise<KnowledgeDerivedDocument | undefined> {
		const row = this.database
			.prepare("SELECT * FROM knowledge_derivatives WHERE project_id = ? AND path = ?")
			.get(projectId, path);
		return row
			? {
					projectId,
					path,
					markdown: String(row.markdown),
					sources: JSON.parse(String(row.sources_json)),
					diagnostics: JSON.parse(String(row.diagnostics_json)),
					parserFingerprint: String(row.parser_fingerprint),
					contentHash: String(row.content_hash),
				}
			: undefined;
	}
	async listDocuments(projectId?: string): Promise<KnowledgeDocument[]> {
		const rows = (projectId
			? this.database
					.prepare("SELECT * FROM knowledge_documents WHERE project_id = ? ORDER BY created_at DESC")
					.all(projectId)
			: this.database
					.prepare("SELECT * FROM knowledge_documents ORDER BY created_at")
					.all()) as unknown as DocumentRow[];
		return rows.map(document);
	}
	async getDocument(projectId: string, id: string): Promise<KnowledgeDocument | undefined> {
		const row = this.database
			.prepare("SELECT * FROM knowledge_documents WHERE project_id = ? AND id = ?")
			.get(projectId, id) as unknown as DocumentRow | undefined;
		return row ? document(row) : undefined;
	}
	async saveDocument(value: KnowledgeDocument): Promise<void> {
		this.database
			.prepare(
				`INSERT INTO knowledge_documents(id,project_id,name,path,mime_type,size,sha256,status,stage,chunk_count,processed_chunks,page_count,error,created_at,updated_at,diagnostics_json,data_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,stage=excluded.stage,chunk_count=excluded.chunk_count,processed_chunks=excluded.processed_chunks,page_count=excluded.page_count,error=excluded.error,updated_at=excluded.updated_at,diagnostics_json=excluded.diagnostics_json,data_json=excluded.data_json`,
			)
			.run(
				value.id,
				value.projectId,
				value.name,
				value.path,
				value.mimeType,
				value.size,
				value.sha256,
				value.status,
				value.stage,
				value.chunkCount,
				value.processedChunks,
				value.pageCount ?? null,
				value.error ?? null,
				value.createdAt,
				value.updatedAt,
				JSON.stringify(value.diagnostics ?? []),
				JSON.stringify(value),
			);
	}
	async listRepresentations(projectId: string, documentId: string): Promise<PerceptualRepresentation[]> {
		return this.database
			.prepare(
				"SELECT data_json FROM knowledge_representations WHERE project_id = ? AND document_id = ? ORDER BY id",
			)
			.all(projectId, documentId)
			.map((row) => JSON.parse(String(row.data_json)) as PerceptualRepresentation);
	}
	async documentReferenceCount(projectId: string, documentId: string): Promise<number> {
		let count = 0;
		for (const [table, field] of [
			["semantic_memories", "evidence"],
			["episodic_memories", "sources"],
			["working_checkpoints", "sources"],
		]) {
			count += Number(
				this.database
					.prepare(
						`SELECT count(*) AS count FROM ${table} m,json_each(m.data_json,'$.${field}') e WHERE m.project_id=? AND json_extract(e.value,'$.kind')='document' AND json_extract(e.value,'$.id')=?`,
					)
					.get(projectId, documentId)?.count ?? 0,
			);
		}
		return count;
	}
	async saveRepresentation(value: PerceptualRepresentation): Promise<void> {
		this.database
			.prepare(
				"INSERT INTO knowledge_representations VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET data_json=excluded.data_json,model_fingerprint=excluded.model_fingerprint,content_version=excluded.content_version",
			)
			.run(
				value.id,
				value.projectId,
				value.documentId,
				value.contentVersion,
				value.modelFingerprint,
				JSON.stringify(value),
			);
	}
	async replacePerceptualVectors(projectId: string, documentId: string, values: PerceptualVector[]): Promise<void> {
		for (const value of values) {
			if (
				value.projectId !== projectId ||
				value.documentId !== documentId ||
				!value.vector.length ||
				value.vector.length > 8192 ||
				!value.vector.every(Number.isFinite)
			)
				throw new WorkbenchError("invalid_input", "感知向量的范围或维度无效");
		}
		this.database.transaction(() => {
			this.database
				.prepare("DELETE FROM knowledge_perceptual_vectors WHERE project_id = ? AND document_id = ?")
				.run(projectId, documentId);
			for (const value of values)
				this.database
					.prepare("INSERT INTO knowledge_perceptual_vectors VALUES(?,?,?,?,?,?,?,?)")
					.run(
						value.id,
						projectId,
						documentId,
						value.contentVersion,
						value.spaceId,
						value.vector.length,
						new Uint8Array(new Float32Array(value.vector).buffer),
						JSON.stringify({ ...value, vector: undefined }),
					);
		});
	}
	async searchPerceptualVectors(
		projectId: string,
		spaceId: string,
		vector: number[],
		limit: number,
	): Promise<KnowledgeHit[]> {
		if (!vector.length || !vector.every(Number.isFinite)) throw new WorkbenchError("invalid_input", "查询向量无效");
		const dimensions = this.database
			.prepare("SELECT DISTINCT dimension FROM knowledge_perceptual_vectors WHERE project_id=? AND space_id=?")
			.all(projectId, spaceId);
		if (dimensions.some((row) => Number(row.dimension) !== vector.length))
			throw new WorkbenchError("conflict", "图文向量空间维度已改变，请重新建立索引");
		const rows = this.database
			.prepare(
				`SELECT v.data_json,d.path,vec_distance_cosine(v.embedding,?) AS distance FROM knowledge_perceptual_vectors v JOIN knowledge_documents d ON d.id=v.document_id AND d.project_id=v.project_id WHERE v.project_id=? AND v.space_id=? AND v.dimension=? AND v.content_version=COALESCE(json_extract(d.data_json,'$.contentVersion'),1) AND d.status='ready' AND json_extract(d.data_json,'$.supersededBy') IS NULL AND COALESCE(json_extract(d.data_json,'$.processingState'),'')!='stale' ORDER BY distance,v.id LIMIT ?`,
			)
			.all(
				new Uint8Array(new Float32Array(vector).buffer),
				projectId,
				spaceId,
				vector.length,
				Math.max(1, Math.min(100, limit)),
			);
		return rows.map((row) => {
			const value = JSON.parse(String(row.data_json)) as PerceptualVector;
			return {
				id: value.id,
				path: String(row.path),
				chunk: -1,
				documentId: value.documentId,
				text: value.text,
				sources: value.sources,
				score: 1 - Number(row.distance),
			};
		});
	}
	async deleteDocument(projectId: string, id: string): Promise<void> {
		const value = await this.getDocument(projectId, id);
		if (!value) return;
		this.database.transaction(() => {
			this.removeFile(projectId, value.path);
			this.database
				.prepare("DELETE FROM knowledge_derivatives WHERE project_id = ? AND path = ?")
				.run(projectId, value.path);
			this.database.prepare("DELETE FROM knowledge_documents WHERE project_id = ? AND id = ?").run(projectId, id);
		});
	}
}
