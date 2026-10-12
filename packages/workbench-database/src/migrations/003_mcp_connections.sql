CREATE TABLE mcp_connections (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  transport TEXT NOT NULL CHECK (transport IN ('stdio','streamable-http','sse')),
  config_json TEXT NOT NULL,
  auth_kind TEXT NOT NULL CHECK (auth_kind IN ('none','headers','oauth')),
  secret_ref TEXT,
  enabled INTEGER NOT NULL CHECK (enabled IN (0,1)),
  version INTEGER NOT NULL CHECK (version > 0),
  last_connected_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE mcp_tools (
  connection_id TEXT NOT NULL REFERENCES mcp_connections(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  title TEXT,
  description TEXT NOT NULL,
  input_schema_json TEXT NOT NULL,
  definition_hash TEXT NOT NULL,
  read_only_hint INTEGER,
  destructive_hint INTEGER,
  discovered_at TEXT NOT NULL,
  PRIMARY KEY(connection_id, name)
) STRICT;

CREATE TABLE agent_profile_mcp_tools (
  profile_id TEXT NOT NULL REFERENCES agent_profiles(id) ON DELETE CASCADE,
  connection_id TEXT NOT NULL REFERENCES mcp_connections(id) ON DELETE CASCADE,
  tool_name TEXT NOT NULL,
  definition_hash TEXT NOT NULL,
  approval TEXT NOT NULL CHECK (approval IN ('ask','allow')),
  PRIMARY KEY(profile_id, connection_id, tool_name),
  FOREIGN KEY(connection_id, tool_name) REFERENCES mcp_tools(connection_id, name) ON DELETE CASCADE
) STRICT;

