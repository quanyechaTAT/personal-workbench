-- The managed project has one durable Markdown document. Source repositories are unaffected.
UPDATE projects
SET project_file_path = workspace_path || CASE WHEN instr(workspace_path, '\') > 0 THEN '\AGENTS.md' ELSE '/AGENTS.md' END,
    memory_file_path = workspace_path || CASE WHEN instr(workspace_path, '\') > 0 THEN '\AGENTS.md' ELSE '/AGENTS.md' END;
