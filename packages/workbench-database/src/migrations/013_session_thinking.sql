ALTER TABLE sessions ADD COLUMN thinking_level TEXT CHECK (thinking_level IS NULL OR thinking_level IN ('none','minimal','low','medium','high','xhigh','max'));
