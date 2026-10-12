CREATE TABLE knowledge_files (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  model_fingerprint TEXT NOT NULL,
  chunk_count INTEGER NOT NULL,
  indexed_at TEXT NOT NULL,
  PRIMARY KEY (project_id, path)
) STRICT;

CREATE TABLE knowledge_chunks (
  project_id TEXT NOT NULL,
  path TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  text TEXT NOT NULL,
  vector_json TEXT NOT NULL,
  PRIMARY KEY (project_id, path, ordinal),
  FOREIGN KEY (project_id, path) REFERENCES knowledge_files(project_id, path) ON DELETE CASCADE
) STRICT;
