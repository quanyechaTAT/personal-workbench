CREATE TABLE knowledge_documents (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  path TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued','processing','ready','failed')),
  stage TEXT NOT NULL CHECK (stage IN ('queued','parsing','embedding','ready','failed')),
  chunk_count INTEGER NOT NULL DEFAULT 0,
  processed_chunks INTEGER NOT NULL DEFAULT 0,
  page_count INTEGER,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(project_id, sha256)
) STRICT;

ALTER TABLE knowledge_chunks ADD COLUMN dimension INTEGER NOT NULL DEFAULT 0;
ALTER TABLE knowledge_chunks ADD COLUMN start_page INTEGER;
ALTER TABLE knowledge_chunks ADD COLUMN end_page INTEGER;

CREATE TABLE knowledge_vector_dimensions (
  dimension INTEGER PRIMARY KEY CHECK (dimension > 0 AND dimension <= 8192)
) STRICT;
