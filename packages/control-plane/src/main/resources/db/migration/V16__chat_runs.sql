CREATE TABLE IF NOT EXISTS chat_runs (
    id                VARCHAR(36) PRIMARY KEY,
    session_id        VARCHAR(36) NOT NULL REFERENCES sessions(id),
    user_id           VARCHAR(36) NOT NULL REFERENCES users(id),
    workspace_id      VARCHAR(36) NOT NULL REFERENCES workspaces(id),
    idempotency_key   VARCHAR(128) NOT NULL,
    request_hash      VARCHAR(64) NOT NULL,
    provider          VARCHAR(50),
    model             VARCHAR(100),
    tool_mode         VARCHAR(20) NOT NULL DEFAULT 'none',
    user_message_id   VARCHAR(36),
    assistant_message_id VARCHAR(36),
    status            VARCHAR(24) NOT NULL,
    terminal_outcome  VARCHAR(24),
    error_code        VARCHAR(64),
    error_detail      TEXT,
    token_count       INTEGER NOT NULL DEFAULT 0,
    assistant_chars   INTEGER NOT NULL DEFAULT 0,
    created_at        TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    UNIQUE (user_id, session_id, idempotency_key)
);

ALTER TABLE messages ADD COLUMN IF NOT EXISTS run_id VARCHAR(36) REFERENCES chat_runs(id);

CREATE INDEX IF NOT EXISTS idx_chat_runs_session_created
    ON chat_runs (session_id, created_at);

CREATE INDEX IF NOT EXISTS idx_messages_run_id
    ON messages (run_id);
