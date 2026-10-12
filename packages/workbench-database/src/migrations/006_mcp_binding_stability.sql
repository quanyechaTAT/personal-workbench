ALTER TABLE agent_profile_mcp_tools RENAME TO agent_profile_mcp_tools_old;

CREATE TABLE agent_profile_mcp_tools (
  profile_id TEXT NOT NULL REFERENCES agent_profiles(id) ON DELETE CASCADE,
  connection_id TEXT NOT NULL REFERENCES mcp_connections(id) ON DELETE CASCADE,
  tool_name TEXT NOT NULL,
  definition_hash TEXT NOT NULL,
  approval TEXT NOT NULL CHECK (approval IN ('ask','allow')),
  PRIMARY KEY(profile_id, connection_id, tool_name)
) STRICT;

INSERT INTO agent_profile_mcp_tools(profile_id, connection_id, tool_name, definition_hash, approval)
SELECT profile_id, connection_id, tool_name, definition_hash, approval
FROM agent_profile_mcp_tools_old;

DROP TABLE agent_profile_mcp_tools_old;
