ALTER TABLE knowledge_files ADD COLUMN index_fingerprint TEXT NOT NULL DEFAULT '';
ALTER TABLE knowledge_files ADD COLUMN parser_fingerprint TEXT NOT NULL DEFAULT '';
ALTER TABLE knowledge_files ADD COLUMN chunker_fingerprint TEXT NOT NULL DEFAULT '';
ALTER TABLE knowledge_files ADD COLUMN tokenizer_fingerprint TEXT NOT NULL DEFAULT '';
ALTER TABLE knowledge_chunks ADD COLUMN stable_id TEXT;
ALTER TABLE knowledge_chunks ADD COLUMN metadata_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE knowledge_documents ADD COLUMN diagnostics_json TEXT NOT NULL DEFAULT '[]';
CREATE UNIQUE INDEX knowledge_chunk_stable_id ON knowledge_chunks(stable_id) WHERE stable_id IS NOT NULL;
CREATE TABLE knowledge_settings (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  settings_json TEXT NOT NULL
) STRICT;
CREATE TABLE knowledge_derivatives (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  markdown TEXT NOT NULL,
  sources_json TEXT NOT NULL,
  diagnostics_json TEXT NOT NULL,
  parser_fingerprint TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  PRIMARY KEY(project_id,path)
) STRICT;
CREATE VIRTUAL TABLE knowledge_keywords USING fts5(chunk_id UNINDEXED, project_id UNINDEXED, terms, tokenize='unicode61');
INSERT INTO knowledge_keywords(chunk_id,project_id,terms) SELECT rowid,project_id,lower(text) FROM knowledge_chunks;
