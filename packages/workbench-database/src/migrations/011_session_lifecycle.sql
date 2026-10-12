ALTER TABLE sessions ADD COLUMN archived_at TEXT;
ALTER TABLE sessions ADD COLUMN deletion_requested_at TEXT;
CREATE INDEX sessions_lifecycle_idx ON sessions(deletion_requested_at, archived_at, last_active_at DESC);
