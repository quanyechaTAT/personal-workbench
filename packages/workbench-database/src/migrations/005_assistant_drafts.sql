CREATE TABLE assistant_drafts (
  id TEXT PRIMARY KEY,
  requirement TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('generating','ready','failed','cancelled','created')),
  config_json TEXT,
  model_json TEXT,
  error_message TEXT,
  version INTEGER NOT NULL CHECK (version > 0),
  created_profile_id TEXT REFERENCES agent_profiles(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE INDEX assistant_drafts_status_updated_idx ON assistant_drafts(status, updated_at DESC);

