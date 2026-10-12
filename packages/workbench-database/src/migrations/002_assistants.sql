ALTER TABLE agent_profiles ADD COLUMN status TEXT NOT NULL DEFAULT 'active'
  CHECK (status IN ('active','archived'));
ALTER TABLE agent_profiles ADD COLUMN version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0);

CREATE TABLE agent_profile_revisions (
  profile_id TEXT NOT NULL REFERENCES agent_profiles(id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK (version > 0),
  config_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(profile_id, version)
) STRICT;

CREATE TABLE agent_profile_skills (
  profile_id TEXT NOT NULL REFERENCES agent_profiles(id) ON DELETE CASCADE,
  skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  PRIMARY KEY(profile_id, skill_id)
) STRICT;

ALTER TABLE sessions ADD COLUMN applied_profile_version INTEGER;
ALTER TABLE sessions ADD COLUMN configuration_fingerprint TEXT;
ALTER TABLE agent_runs ADD COLUMN profile_version INTEGER;
ALTER TABLE agent_runs ADD COLUMN capabilities_json TEXT;

