ALTER TABLE chat_runs ADD COLUMN IF NOT EXISTS lease_owner VARCHAR(80);
ALTER TABLE chat_runs ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMP WITH TIME ZONE;

CREATE INDEX IF NOT EXISTS idx_chat_runs_active_lease
    ON chat_runs (session_id, status, lease_expires_at);
