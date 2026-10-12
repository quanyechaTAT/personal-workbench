CREATE TABLE working_checkpoints (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  project_id TEXT,
  run_id TEXT,
  version INTEGER NOT NULL CHECK(version > 0),
  status TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  data_json TEXT NOT NULL CHECK(json_valid(data_json))
) STRICT;
CREATE INDEX working_checkpoints_expiry ON working_checkpoints(expires_at);

-- Retained evidence survives conversation cache deletion. No transcript is duplicated.
CREATE TABLE episodic_memories (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  session_id TEXT NOT NULL,
  run_id TEXT NOT NULL UNIQUE,
  task_id TEXT,
  occurred_at TEXT NOT NULL,
  outcome TEXT NOT NULL,
  search_text TEXT NOT NULL,
  data_json TEXT NOT NULL CHECK(json_valid(data_json))
) STRICT;
CREATE INDEX episodic_memories_scope_time ON episodic_memories(project_id, occurred_at DESC);
CREATE INDEX episodic_memories_session ON episodic_memories(session_id, occurred_at DESC);

CREATE TABLE memory_contexts (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL,
  request INTEGER NOT NULL,
  data_json TEXT NOT NULL CHECK(json_valid(data_json))
) STRICT;
