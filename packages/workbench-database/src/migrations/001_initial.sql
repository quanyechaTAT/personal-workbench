CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('creating','active','paused','completed','archived','failed')),
  workspace_path TEXT NOT NULL,
  project_file_path TEXT NOT NULL,
  memory_file_path TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT
) STRICT;

CREATE INDEX projects_status_updated_idx ON projects(status, updated_at DESC);

CREATE TABLE agent_profiles (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  system_prompt TEXT NOT NULL,
  default_model_json TEXT,
  tools_json TEXT NOT NULL,
  skills_json TEXT NOT NULL,
  is_builtin INTEGER NOT NULL CHECK (is_builtin IN (0,1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  runtime TEXT NOT NULL,
  runtime_session_id TEXT NOT NULL,
  runtime_ref TEXT NOT NULL,
  project_id TEXT REFERENCES projects(id),
  agent_profile_id TEXT NOT NULL REFERENCES agent_profiles(id),
  title TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('personal','project','background','subagent')),
  status TEXT NOT NULL CHECK (status IN ('idle','running','interrupted','unavailable','closed')),
  cwd TEXT NOT NULL,
  model_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_active_at TEXT NOT NULL,
  closed_at TEXT,
  unavailable_reason TEXT,
  UNIQUE(runtime, runtime_session_id),
  CHECK (kind <> 'project' OR project_id IS NOT NULL)
) STRICT;

CREATE INDEX sessions_project_active_idx ON sessions(project_id, last_active_at DESC);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id),
  parent_id TEXT REFERENCES tasks(id),
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('human','agent')),
  status TEXT NOT NULL CHECK (status IN ('backlog','todo','running','blocked','review','done','failed','cancelled')),
  priority INTEGER NOT NULL CHECK (priority BETWEEN 0 AND 4),
  assigned_to TEXT NOT NULL,
  due_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  version INTEGER NOT NULL CHECK (version > 0)
) STRICT;

CREATE INDEX tasks_project_status_due_idx ON tasks(project_id, status, due_at);
CREATE INDEX tasks_parent_idx ON tasks(parent_id);

CREATE TABLE task_runs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  session_id TEXT REFERENCES sessions(id),
  agent_run_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('queued','running','interrupted','review','failed','cancelled')),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  error_code TEXT,
  summary TEXT,
  created_at TEXT NOT NULL
) STRICT;

CREATE INDEX task_runs_status_started_idx ON task_runs(status, started_at DESC);

CREATE TABLE memory_files (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('user','global','daily','project')),
  project_id TEXT REFERENCES projects(id),
  relative_path TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  size INTEGER NOT NULL CHECK (size >= 0),
  modified_at TEXT,
  indexed_at TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0)
) STRICT;

CREATE UNIQUE INDEX memory_files_identity_idx ON memory_files(kind, ifnull(project_id, ''), relative_path);

CREATE TABLE memory_index (
  id TEXT PRIMARY KEY,
  memory_file_id TEXT NOT NULL REFERENCES memory_files(id) ON DELETE CASCADE,
  project_id TEXT REFERENCES projects(id),
  kind TEXT NOT NULL CHECK (kind IN ('user','global','daily','project')),
  heading TEXT,
  start_line INTEGER NOT NULL CHECK (start_line > 0),
  end_line INTEGER NOT NULL CHECK (end_line >= start_line),
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  occurred_on TEXT,
  created_at TEXT NOT NULL
) STRICT;

CREATE INDEX memory_index_scope_idx ON memory_index(project_id, kind, occurred_on DESC);
CREATE INDEX memory_index_file_idx ON memory_index(memory_file_id);
CREATE VIRTUAL TABLE memory_index_fts USING fts5(
  heading,
  content,
  content='memory_index',
  content_rowid='rowid',
  tokenize='unicode61'
);
CREATE TRIGGER memory_index_ai AFTER INSERT ON memory_index BEGIN
  INSERT INTO memory_index_fts(rowid, heading, content) VALUES (new.rowid, new.heading, new.content);
END;
CREATE TRIGGER memory_index_ad AFTER DELETE ON memory_index BEGIN
  INSERT INTO memory_index_fts(memory_index_fts, rowid, heading, content) VALUES ('delete', old.rowid, old.heading, old.content);
END;
CREATE TRIGGER memory_index_au AFTER UPDATE ON memory_index BEGIN
  INSERT INTO memory_index_fts(memory_index_fts, rowid, heading, content) VALUES ('delete', old.rowid, old.heading, old.content);
  INSERT INTO memory_index_fts(rowid, heading, content) VALUES (new.rowid, new.heading, new.content);
END;

CREATE TABLE memory_candidates (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('user','global','daily','project')),
  project_id TEXT REFERENCES projects(id),
  relative_path TEXT NOT NULL,
  heading TEXT,
  proposed_text TEXT NOT NULL,
  reason TEXT NOT NULL,
  preview TEXT NOT NULL,
  base_hash TEXT NOT NULL,
  applied_hash TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending','accepted','rejected','conflicted','failed')),
  session_id TEXT,
  run_id TEXT,
  tool_call_id TEXT,
  idempotency_key TEXT UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  resolved_at TEXT
) STRICT;

CREATE INDEX memory_candidates_status_created_idx ON memory_candidates(status, created_at DESC);

CREATE TABLE skills (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('global','project')),
  project_id TEXT REFERENCES projects(id),
  enabled INTEGER NOT NULL CHECK (enabled IN (0,1)),
  path TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  is_builtin INTEGER NOT NULL CHECK (is_builtin IN (0,1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE UNIQUE INDEX skills_identity_idx ON skills(scope, ifnull(project_id, ''), slug);

CREATE TABLE artifacts (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id),
  session_id TEXT REFERENCES sessions(id),
  task_run_id TEXT REFERENCES task_runs(id),
  type TEXT NOT NULL CHECK (type IN ('document','report','code','analysis','dataset','export','other')),
  name TEXT NOT NULL,
  file_path TEXT NOT NULL,
  relative_path TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size INTEGER NOT NULL CHECK (size >= 0),
  sha256 TEXT NOT NULL,
  tool_call_id TEXT,
  idempotency_key TEXT UNIQUE,
  created_at TEXT NOT NULL
) STRICT;

CREATE INDEX artifacts_project_created_idx ON artifacts(project_id, created_at DESC);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE agent_runs (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  task_run_id TEXT REFERENCES task_runs(id),
  status TEXT NOT NULL CHECK (status IN ('running','completed','aborted','failed','interrupted')),
  input_message_id TEXT NOT NULL,
  final_message_id TEXT,
  profile_slug TEXT NOT NULL,
  model_json TEXT,
  started_at TEXT NOT NULL,
  settled_at TEXT,
  error_code TEXT,
  error_message TEXT
) STRICT;

CREATE INDEX agent_runs_status_started_idx ON agent_runs(status, started_at DESC);

CREATE TABLE approvals (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  tool_call_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  operation_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','approved','denied','cancelled','expired')),
  requested_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  resolved_at TEXT
) STRICT;

CREATE INDEX approvals_status_expiry_idx ON approvals(status, expires_at);

CREATE TABLE activity (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id),
  session_id TEXT REFERENCES sessions(id),
  run_id TEXT,
  type TEXT NOT NULL,
  summary TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

CREATE INDEX activity_project_created_idx ON activity(project_id, created_at DESC);

CREATE TABLE idempotency_records (
  key TEXT PRIMARY KEY,
  operation TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
) STRICT;
