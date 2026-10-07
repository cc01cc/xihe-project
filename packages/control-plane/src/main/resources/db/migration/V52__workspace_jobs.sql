-- PLAN-0465 T1.1: workspace_jobs — the Workspace Job domain store (PLAN-0462
-- decision #5/#7: a Workspace Job is an independent Workspace-owned entity
-- identified by the domain `jobId`; `operationItemId` is no longer its identity).
--
-- Delta-only (no legacy data is migrated, PLAN-0462 decision #9):
--   * `id` = domain jobId (CP-generated UUID; the only identity on the wire).
--   * `state` JSONB = the former `job_state` extension payload, keeping the
--     row-lock + monotonic-forward semantics (JobStateService). The Runtime
--     backend handle stays inside `state->>'jobId'` and is mirrored into
--     `runtime_job_id` (the output/status/cancel reference toward Runtime).
--   * `status` / `scope` are promoted query columns (mirrored from `state`)
--     so active scans and the 0466 audit VIEW never parse JSONB per row.
--   * `operation_item_id` = dual-write anchor to the legacy job item that this
--     plan keeps writing until PLAN-0467; it also keys the transition routes
--     (`/api/v1/operations/items/{itemId}/...`) that survive until then.
--     NULLABLE on purpose: post-PLAN-0464 chat-run MCP tool calls no longer
--     create ledger tool items (Agent stopped sending X-Operation-Id), so
--     MCP-started chat jobs carry `tool_call_id`/`run_id`/`session_id`
--     provenance instead of a legacy item; workspace-start jobs keep the anchor.
--   * Idempotency = V36 semantics moved in: session-bound rows are unique on
--     (user, session, key); session-less rows are unique on (user, workspace,
--     key). `input_hash` conflicts map to 409 in the service layer.

CREATE TABLE workspace_jobs (
    id                UUID PRIMARY KEY,
    workspace_id      UUID         NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
    user_id           UUID         NOT NULL REFERENCES users (id),
    session_id        UUID REFERENCES sessions (id) ON DELETE CASCADE,
    run_id            UUID REFERENCES chat_runs (id) ON DELETE SET NULL,
    tool_call_id      UUID,
    operation_item_id UUID REFERENCES operation_items (id) ON DELETE CASCADE,
    source            VARCHAR(32)  NOT NULL,
    scope             VARCHAR(16)  NOT NULL,
    idempotency_key   VARCHAR(128),
    input_hash        VARCHAR(64),
    status            VARCHAR(24)  NOT NULL,
    state             JSONB        NOT NULL,
    cancel_reason     VARCHAR(64),
    error_code        VARCHAR(64),
    runtime_job_id    VARCHAR(128),
    started_at        TIMESTAMPTZ,
    ended_at          TIMESTAMPTZ,
    created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    CONSTRAINT ck_workspace_jobs_scope CHECK (scope IN ('run', 'session', 'workspace')),
    CONSTRAINT ck_workspace_jobs_status CHECK (
        status IN ('pending', 'running', 'succeeded', 'cancelled', 'timeout',
                   'orphaned', 'interrupted'))
);

-- V36 semantics migrated in (session-bound previously relied on
-- uq_session_operations_idempotency; session-less needed the partial index).
CREATE UNIQUE INDEX uq_workspace_jobs_session_idempotency
    ON workspace_jobs (user_id, session_id, idempotency_key)
    WHERE session_id IS NOT NULL AND idempotency_key IS NOT NULL;

CREATE UNIQUE INDEX uq_workspace_jobs_workspace_idempotency
    ON workspace_jobs (user_id, workspace_id, idempotency_key)
    WHERE session_id IS NULL AND idempotency_key IS NOT NULL;

-- Dual-write anchor: one legacy job item maps to at most one domain row.
CREATE UNIQUE INDEX uq_workspace_jobs_operation_item
    ON workspace_jobs (operation_item_id);

-- Time index: workspace list + PLAN-0466 audit VIEW pagination.
CREATE INDEX idx_workspace_jobs_workspace_created_at
    ON workspace_jobs (workspace_id, created_at DESC);

-- Reconciliation sweep (findRunningSince) bounds on created_at.
CREATE INDEX idx_workspace_jobs_created_at
    ON workspace_jobs (created_at);

-- Scope closure lookups (run/session boundary) are equality probes.
CREATE INDEX idx_workspace_jobs_run_id
    ON workspace_jobs (run_id) WHERE run_id IS NOT NULL;

CREATE INDEX idx_workspace_jobs_session_id
    ON workspace_jobs (session_id) WHERE session_id IS NOT NULL;
