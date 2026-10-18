-- =============================================================================
-- XH Control Plane — PLAN-0528: chat_run_guidance durable owner
--
-- CP-owned Run-scoped Guidance records for in-run Steering (PLAN-0468 frozen
-- contract; rulings 1A/2A/3A/4A + candidate-①). Separate from Message,
-- Follow-up Queue and EventStore. No historical backfill: existing runs start
-- with no guidance rows. forward-only.
--
-- source_kind is fail-closed to 'user' at the DB level: guard submission
-- requires a new migration plus a Security-track ruling (1A).
-- =============================================================================

CREATE TABLE chat_run_guidance (
    id UUID NOT NULL,
    session_id UUID NOT NULL,
    run_id UUID NOT NULL,
    branch_id UUID NOT NULL,
    source_kind VARCHAR(16) NOT NULL,
    author_principal_id UUID NOT NULL,
    body_markdown TEXT NOT NULL,
    sequence BIGINT NOT NULL,
    status VARCHAR(24) NOT NULL DEFAULT 'pending',
    idempotency_key VARCHAR(128) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    consumed_at TIMESTAMPTZ,
    terminal_expired_at TIMESTAMPTZ,
    CONSTRAINT pk_chat_run_guidance PRIMARY KEY (id),
    CONSTRAINT ck_chat_run_guidance_source_kind CHECK (source_kind = 'user'),
    CONSTRAINT ck_chat_run_guidance_body_length CHECK (char_length(body_markdown) <= 8000),
    CONSTRAINT ck_chat_run_guidance_status CHECK (status IN ('pending', 'consumed', 'terminal_expired')),
    CONSTRAINT fk_chat_run_guidance_run
        FOREIGN KEY (run_id) REFERENCES chat_runs (id) ON DELETE CASCADE,
    CONSTRAINT uq_chat_run_guidance_run_sequence UNIQUE (run_id, sequence),
    CONSTRAINT uq_chat_run_guidance_run_idempotency UNIQUE (run_id, idempotency_key)
);

CREATE INDEX idx_chat_run_guidance_run_status ON chat_run_guidance (run_id, status);
CREATE INDEX idx_chat_run_guidance_session ON chat_run_guidance (session_id);
