-- Freeze the effective policy of existing projects before changing the new-project default.
INSERT OR IGNORE INTO settings(key, value_json, version, updated_at)
SELECT 'learning.project.' || id,
       COALESCE((SELECT value_json FROM settings WHERE key = 'learning.defaultMode'), '"review"'),
       1, updated_at
FROM projects;

CREATE TABLE learning_skill_state (
  skill_id TEXT PRIMARY KEY REFERENCES skills(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  data_json TEXT NOT NULL CHECK(json_valid(data_json))
) STRICT;
CREATE INDEX learning_skill_project ON learning_skill_state(project_id);

CREATE TABLE learning_skill_uses (
  run_id TEXT NOT NULL,
  skill_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  loaded_at TEXT NOT NULL,
  data_json TEXT NOT NULL CHECK(json_valid(data_json)),
  PRIMARY KEY(run_id, skill_id, content_hash)
) STRICT;
CREATE INDEX learning_use_project ON learning_skill_uses(project_id, loaded_at DESC);

CREATE TABLE learning_snapshots (
  source_key TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  data_json TEXT NOT NULL CHECK(json_valid(data_json))
) STRICT;
