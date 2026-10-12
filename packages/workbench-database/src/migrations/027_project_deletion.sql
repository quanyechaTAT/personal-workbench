-- Preserve the complete deletion scope until managed files and native Pi history are removed.
CREATE TABLE project_deletions (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  data_json TEXT NOT NULL CHECK(json_valid(data_json)),
  requested_at TEXT NOT NULL
) STRICT;
