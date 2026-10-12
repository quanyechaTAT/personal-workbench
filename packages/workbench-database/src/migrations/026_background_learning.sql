-- Automatic learning is the sole project policy. Scheduling is internal again.
DELETE FROM settings WHERE key IN ('learning.defaultMode', 'learning.schedule')
  OR key LIKE 'learning.project.%' OR key LIKE 'learning.schedule.%';
-- Application recovery must finish file journals and verify legacy Skill ownership
-- before deleting the old review records. This marker is consumed transactionally once.
INSERT INTO settings(key, value_json, version, updated_at)
VALUES ('learning.historyResetPending', 'true', 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
