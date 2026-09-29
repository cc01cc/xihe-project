-- PLAN-0409 T6.4: one durable fork-request record is the Idempotency ledger
-- and the filesystem cleanup recovery source. No independent work queue.
-- Request rows intentionally have no Session FK so cleanup state survives a
-- source/child Session delete. Child publication remains in the final DB tx.

CREATE TABLE session_fork_requests (
    child_session_id UUID         NOT NULL,
    source_session_id UUID        NOT NULL,
    idempotency_key  VARCHAR(128) NOT NULL,
    request_hash     VARCHAR(64)  NOT NULL,
    state            VARCHAR(24)  NOT NULL,
    cleanup_ref      TEXT         NOT NULL,
    created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    last_error_code  VARCHAR(128),
    CONSTRAINT pk_session_fork_requests
        PRIMARY KEY (child_session_id),
    CONSTRAINT uq_session_fork_requests_source_key
        UNIQUE (source_session_id, idempotency_key),
    CONSTRAINT ck_session_fork_requests_hash
        CHECK (length(request_hash) = 64),
    CONSTRAINT ck_session_fork_requests_state
        CHECK (state IN ('copying', 'cleanup_pending', 'retryable', 'completed'))
);

CREATE INDEX idx_session_fork_requests_recovery
    ON session_fork_requests (state, updated_at);
