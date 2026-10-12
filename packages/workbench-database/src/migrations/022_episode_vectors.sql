CREATE TABLE episodic_vectors (
  id TEXT PRIMARY KEY REFERENCES episodic_memories(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  space_id TEXT NOT NULL,
  dimension INTEGER NOT NULL CHECK(dimension > 0 AND dimension <= 8192),
  embedding BLOB NOT NULL
) STRICT;
CREATE INDEX episodic_vectors_space ON episodic_vectors(space_id, dimension);
