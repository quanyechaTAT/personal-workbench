ALTER TABLE skills ADD COLUMN source_kind TEXT NOT NULL DEFAULT 'workspace'
  CHECK (source_kind IN ('builtin','local','git','workspace'));
ALTER TABLE skills ADD COLUMN source_url TEXT;
ALTER TABLE skills ADD COLUMN source_ref TEXT;
ALTER TABLE skills ADD COLUMN source_commit TEXT;
ALTER TABLE skills ADD COLUMN source_subdirectory TEXT;
ALTER TABLE skills ADD COLUMN diagnostics_json TEXT NOT NULL DEFAULT '[]';

CREATE TABLE skill_imports (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL CHECK (source IN ('local','git')),
  source_location TEXT NOT NULL,
  source_ref TEXT,
  source_commit TEXT,
  source_subdirectory TEXT,
  scope TEXT NOT NULL CHECK (scope IN ('global','project')),
  project_id TEXT REFERENCES projects(id),
  staging_path TEXT NOT NULL,
  candidates_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('preview','committed','discarded','failed')),
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE INDEX skill_imports_status_created_idx ON skill_imports(status, created_at DESC);

