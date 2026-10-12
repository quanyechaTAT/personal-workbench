-- Counters and bounded references only; the Pi JSONL remains the conversation source.
CREATE TABLE learning_cadence (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  data_json TEXT NOT NULL CHECK(json_valid(data_json))
) STRICT;
CREATE TABLE learning_counted_runs (
  run_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE
) STRICT;
CREATE INDEX learning_cadence_project ON learning_cadence(project_id);
