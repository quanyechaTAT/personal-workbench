CREATE TABLE project_learning_reviews (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK(status IN ('queued', 'running', 'ready', 'empty', 'failed', 'interrupted', 'cancelled')),
  version INTEGER NOT NULL,
  data_json TEXT NOT NULL CHECK(json_valid(data_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE INDEX project_learning_recent ON project_learning_reviews(project_id, created_at DESC);
