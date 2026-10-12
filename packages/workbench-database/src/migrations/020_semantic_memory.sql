ALTER TABLE memory_candidates ADD COLUMN semantic_json TEXT;
CREATE TABLE memory_write_intents (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  data_json TEXT NOT NULL CHECK(json_valid(data_json))
) STRICT;
CREATE TABLE semantic_memories (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  kind TEXT NOT NULL,
  relative_path TEXT NOT NULL,
  text TEXT NOT NULL,
  version INTEGER NOT NULL,
  status TEXT NOT NULL,
  confirmation TEXT NOT NULL,
  valid_from TEXT NOT NULL,
  valid_until TEXT,
  data_json TEXT NOT NULL CHECK(json_valid(data_json))
) STRICT;
CREATE INDEX semantic_memories_scope ON semantic_memories(project_id, kind, status);
CREATE TABLE semantic_versions (
  id TEXT NOT NULL,
  version INTEGER NOT NULL,
  data_json TEXT NOT NULL CHECK(json_valid(data_json)),
  PRIMARY KEY(id, version)
) STRICT;
-- Rebuildable vectors use the existing SQLite / sqlite-vec engine. No additional store.
CREATE TABLE semantic_vectors (
  id TEXT PRIMARY KEY REFERENCES semantic_memories(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  space_id TEXT NOT NULL,
  dimension INTEGER NOT NULL,
  embedding BLOB NOT NULL
) STRICT;
