-- Preserve evidence age during upgrade; never make old observations newly verified.
UPDATE semantic_memories SET data_json = json_set(json_remove(data_json, '$.externalHash'),
  '$.confidence', CASE confirmation WHEN 'user_confirmed' THEN 1.0 WHEN 'verified' THEN 0.85 ELSE 0.4 END,
  '$.createdAt', json_extract(data_json, '$.validFrom'),
  '$.lastVerifiedAt', json_extract(data_json, '$.updatedAt'))
WHERE json_extract(data_json, '$.confidence') IS NULL;

UPDATE semantic_versions SET data_json = json_set(json_remove(data_json, '$.externalHash'),
  '$.confidence', CASE json_extract(data_json, '$.confirmation') WHEN 'user_confirmed' THEN 1.0 WHEN 'verified' THEN 0.85 ELSE 0.4 END,
  '$.createdAt', json_extract(data_json, '$.validFrom'),
  '$.lastVerifiedAt', json_extract(data_json, '$.updatedAt'))
WHERE json_extract(data_json, '$.confidence') IS NULL;

-- Observation confidence describes the event, including a failed event, not a reusable solution.
UPDATE working_checkpoints SET data_json = json_set(data_json, '$.confidence', 0.9)
WHERE json_extract(data_json, '$.confidence') IS NULL;
UPDATE episodic_memories SET data_json = json_set(data_json, '$.confidence', 0.9)
WHERE json_extract(data_json, '$.confidence') IS NULL;
UPDATE learning_skill_state SET data_json = json_set(data_json,
  '$.confidence', 0.85,
  '$.createdAt', json_extract(data_json, '$.updatedAt'),
  '$.lastVerifiedAt', json_extract(data_json, '$.updatedAt'))
WHERE json_extract(data_json, '$.confidence') IS NULL;
