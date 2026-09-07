CREATE TABLE IF NOT EXISTS approval_requests (
    request_id          VARCHAR(36) PRIMARY KEY,
    run_id              VARCHAR(36) NOT NULL REFERENCES chat_runs(id),
    session_id          VARCHAR(36) NOT NULL REFERENCES sessions(id),
    user_id             VARCHAR(36) NOT NULL REFERENCES users(id),
    workspace_id        VARCHAR(36) NOT NULL REFERENCES workspaces(id),
    tool                VARCHAR(80) NOT NULL,
    action              VARCHAR(512) NOT NULL,
    details             TEXT,
    state               VARCHAR(24) NOT NULL,
    approved            BOOLEAN,
    expires_at          TIMESTAMP WITH TIME ZONE NOT NULL,
    created_at          TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    decided_at          TIMESTAMP WITH TIME ZONE,
    dispatch_error_code VARCHAR(64)
);

CREATE INDEX IF NOT EXISTS idx_approval_requests_session_state
    ON approval_requests (session_id, user_id, workspace_id, state, created_at);

CREATE INDEX IF NOT EXISTS idx_approval_requests_run_state
    ON approval_requests (run_id, state);
