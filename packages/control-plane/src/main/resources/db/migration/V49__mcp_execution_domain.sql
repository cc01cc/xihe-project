-- PLAN-0463 T1.1: MCP execution domain tables (mcp_invocations / mcp_attempts /
-- mcp_dispatch_history). Design key 1-5 + owner-matrix MCPX rows.
--
-- Delta-only: this migration only CREATEs three new tables and their indexes.
-- It does not ALTER, DROP or backfill any existing table (PLAN-0462 decision
-- #9: no backfill; Ledger retirement belongs to 0467). No chat root, no
-- approval_history (0464), no workspace_jobs (0465).

CREATE TABLE mcp_invocations (
    id                  UUID PRIMARY KEY,
    tool_call_id        UUID         NOT NULL,
    run_id              UUID,
    session_id          UUID,
    workspace_id        UUID         NOT NULL,
    user_id             UUID         NOT NULL,
    source              VARCHAR(16)  NOT NULL,
    tool_name           VARCHAR(128) NOT NULL,
    arguments_preview   TEXT,
    policy_decision     VARCHAR(16),
    policy_summary      TEXT,
    approval_request_id UUID,
    status              VARCHAR(24)  NOT NULL,
    error_code          VARCHAR(64),
    request_id          UUID,
    started_at          TIMESTAMPTZ  NOT NULL,
    finished_at         TIMESTAMPTZ,
    created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    CONSTRAINT ck_mcp_invocations_source CHECK (source IN ('agent', 'direct_user')),
    CONSTRAINT ck_mcp_invocations_status CHECK (
        status IN ('active', 'completed', 'failed', 'unknown', 'cancelled'))
);

-- Agent idempotency key: one invocation per (run, toolCallId). direct_user rows
-- carry a NULL run_id and are therefore intentionally not deduplicated.
CREATE UNIQUE INDEX uq_mcp_invocations_run_tool_call
    ON mcp_invocations (run_id, tool_call_id)
    WHERE run_id IS NOT NULL;

CREATE INDEX idx_mcp_invocations_workspace_status
    ON mcp_invocations (workspace_id, status);

CREATE INDEX idx_mcp_invocations_user
    ON mcp_invocations (user_id, created_at);

CREATE TABLE mcp_attempts (
    id             UUID PRIMARY KEY,
    invocation_id  UUID         NOT NULL REFERENCES mcp_invocations (id),
    stage          VARCHAR(24)  NOT NULL,
    retry_no       INTEGER      NOT NULL DEFAULT 0,
    module         VARCHAR(24)  NOT NULL,
    request_id     UUID,
    status         VARCHAR(24)  NOT NULL,
    http_status    INTEGER,
    error_code     VARCHAR(64),
    result_ref     TEXT,
    duration_ms    BIGINT,
    started_at     TIMESTAMPTZ  NOT NULL,
    finished_at    TIMESTAMPTZ,
    created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    CONSTRAINT ck_mcp_attempts_stage CHECK (stage IN ('cp_forward', 'agent_tool')),
    CONSTRAINT ck_mcp_attempts_status CHECK (
        status IN ('started', 'succeeded', 'failed', 'timed_out', 'cancelled',
                   'unknown', 'late_confirmed'))
);

-- Mirror of OperationService.startAttempt idempotency (same invocation + stage
-- + request id replays the winner instead of allocating a second attempt).
CREATE UNIQUE INDEX uq_mcp_attempts_invocation_stage_request
    ON mcp_attempts (invocation_id, stage, request_id)
    WHERE request_id IS NOT NULL;

CREATE INDEX idx_mcp_attempts_invocation_status
    ON mcp_attempts (invocation_id, status);

-- Append-only transition history (PLAN-0462 decision #8): no UPDATE path.
CREATE TABLE mcp_dispatch_history (
    id             UUID PRIMARY KEY,
    invocation_id  UUID         NOT NULL REFERENCES mcp_invocations (id),
    attempt_id     UUID         REFERENCES mcp_attempts (id),
    sequence       BIGINT       NOT NULL,
    event_type     VARCHAR(48)  NOT NULL,
    from_status    VARCHAR(24),
    to_status      VARCHAR(24),
    actor_type     VARCHAR(16)  NOT NULL,
    payload        TEXT,
    created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    CONSTRAINT ck_mcp_dispatch_history_actor CHECK (
        actor_type IN ('system', 'agent', 'cp', 'runtime', 'user'))
);

CREATE UNIQUE INDEX uq_mcp_dispatch_history_invocation_sequence
    ON mcp_dispatch_history (invocation_id, sequence);

CREATE INDEX idx_mcp_dispatch_history_invocation_created
    ON mcp_dispatch_history (invocation_id, created_at);
