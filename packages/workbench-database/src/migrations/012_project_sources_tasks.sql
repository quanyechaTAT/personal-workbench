ALTER TABLE projects ADD COLUMN source_path TEXT;
ALTER TABLE projects ADD COLUMN default_profile_id TEXT REFERENCES agent_profiles(id);
CREATE UNIQUE INDEX projects_source_path_idx ON projects(source_path COLLATE NOCASE) WHERE source_path IS NOT NULL;
ALTER TABLE tasks ADD COLUMN cleanup_requested_at TEXT;
ALTER TABLE tasks ADD COLUMN cleanup_delete_history INTEGER NOT NULL DEFAULT 0 CHECK (cleanup_delete_history IN (0,1));
CREATE INDEX tasks_cleanup_idx ON tasks(cleanup_requested_at);
