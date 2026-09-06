ALTER TABLE sessions
    ADD COLUMN provider_connection_id VARCHAR(36),
    ADD COLUMN connection_revision BIGINT;

ALTER TABLE chat_runs
    ADD COLUMN provider_connection_id VARCHAR(36),
    ADD COLUMN connection_revision BIGINT;

CREATE INDEX idx_sessions_provider_connection
    ON sessions(provider_connection_id);

CREATE INDEX idx_chat_runs_provider_connection
    ON chat_runs(provider_connection_id, connection_revision);
