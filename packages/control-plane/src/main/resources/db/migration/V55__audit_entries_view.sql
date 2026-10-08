-- PLAN-0466 T1.1: v_audit_entries — the read-only audit entry view (decision #1:
-- audit is an on-demand read model; never a persisted copy, never a write path).
--
-- One row per audit entry across the four domain stores (PLAN-0462 decision #8):
--   chat_run        ← chat_runs          (PLAN-0464)
--   workspace_job   ← workspace_jobs     (PLAN-0465)
--   mcp_invocation  ← mcp_invocations    (PLAN-0463)
--   approval        ← approval_requests
--
-- Column tiers (design 关键设计 #1: 列集冻结为 user 列集 + internal 扩展列集两档):
--   * user tier      — type/entry_id/session_id/workspace_id/run_id/status/summary/
--                      source/error_code/timestamps/terminal_outcome/scope/cancel_reason/
--                      tool_call_id/approval_request_id, projected by
--                      GET /api/v1/audit/entries (never userId/key correlation fields).
--   * internal ext   — user_id/idempotency_key/request_id/runtime_job_id, added by
--                      GET /internal/v1/audit/entries/{type}/{id} (service Bearer).
-- Neither tier can ever carry prompt content, credentials or raw arguments: those
-- columns (chat message body, mcp_invocations.arguments_preview, policy_summary raw
-- TEXT, history payload TEXT) are deliberately absent from the VIEW, matching
-- spec/security/audit.md §3 and PLAN-0466 T1.2 redaction.
--
-- `summary` is the non-sensitive list title per type: chat_run → model (prompt text is
-- banned), workspace_job → NULL, mcp_invocation → tool_name, approval → tool.
-- `source` keeps the domain provenance vocabulary (chat_runs.origin /
-- workspace_jobs.source / mcp_invocations.source / approval_requests.origin).
--
-- Delta-only: CREATE VIEW + pagination indexes on existing tables. No table rewrite,
-- no backfill (PLAN-0462 decision #9).

CREATE VIEW v_audit_entries AS
SELECT
    'chat_run'::VARCHAR(24)     AS type,
    r.id                        AS entry_id,
    r.user_id                   AS user_id,
    r.session_id                AS session_id,
    r.workspace_id              AS workspace_id,
    r.id                        AS run_id,
    r.status                    AS status,
    r.model::TEXT               AS summary,
    r.origin                    AS source,
    r.error_code                AS error_code,
    r.created_at                AS created_at,
    NULL::TIMESTAMPTZ           AS started_at,
    r.terminal_at               AS finished_at,
    r.terminal_outcome          AS terminal_outcome,
    NULL::VARCHAR(16)           AS scope,
    NULL::VARCHAR(64)           AS cancel_reason,
    NULL::UUID                  AS tool_call_id,
    NULL::UUID                  AS approval_request_id,
    r.idempotency_key           AS idempotency_key,
    NULL::UUID                  AS request_id,
    NULL::VARCHAR(128)          AS runtime_job_id
FROM chat_runs r
UNION ALL
SELECT
    'workspace_job'::VARCHAR(24),
    j.id,
    j.user_id,
    j.session_id,
    j.workspace_id,
    j.run_id,
    j.status,
    NULL::TEXT,
    j.source,
    j.error_code,
    j.created_at,
    j.started_at,
    j.ended_at,
    NULL::VARCHAR(24),
    j.scope,
    j.cancel_reason,
    j.tool_call_id,
    NULL::UUID,
    j.idempotency_key,
    NULL::UUID,
    j.runtime_job_id
FROM workspace_jobs j
UNION ALL
SELECT
    'mcp_invocation'::VARCHAR(24),
    m.id,
    m.user_id,
    m.session_id,
    m.workspace_id,
    m.run_id,
    m.status,
    m.tool_name::TEXT,
    m.source,
    m.error_code,
    m.created_at,
    m.started_at,
    m.finished_at,
    NULL::VARCHAR(24),
    NULL::VARCHAR(16),
    NULL::VARCHAR(64),
    m.tool_call_id,
    m.approval_request_id,
    NULL::VARCHAR(128),
    m.request_id,
    NULL::VARCHAR(128)
FROM mcp_invocations m
UNION ALL
SELECT
    'approval'::VARCHAR(24),
    a.request_id,
    a.user_id,
    a.session_id,
    a.workspace_id,
    a.run_id,
    a.state,
    a.tool::TEXT,
    a.origin,
    a.dispatch_error_code,
    a.created_at,
    NULL::TIMESTAMPTZ,
    a.decided_at,
    NULL::VARCHAR(24),
    NULL::VARCHAR(16),
    NULL::VARCHAR(64),
    NULL::UUID,
    NULL::UUID,
    NULL::VARCHAR(128),
    NULL::UUID,
    NULL::VARCHAR(128)
FROM approval_requests a;

-- Pagination support: the list query is always owner-scoped
-- (user_id = ? ORDER BY created_at DESC) with optional workspace/session scope.
-- mcp_invocations already has idx_mcp_invocations_user (user_id, created_at).
CREATE INDEX idx_chat_runs_audit_user_created
    ON chat_runs (user_id, created_at DESC);

CREATE INDEX idx_chat_runs_audit_workspace_created
    ON chat_runs (workspace_id, created_at DESC);

CREATE INDEX idx_workspace_jobs_audit_user_created
    ON workspace_jobs (user_id, created_at DESC);

CREATE INDEX idx_approval_requests_audit_user_created
    ON approval_requests (user_id, created_at DESC);

CREATE INDEX idx_mcp_invocations_audit_workspace_created
    ON mcp_invocations (workspace_id, created_at DESC);

CREATE INDEX idx_approval_requests_audit_workspace_created
    ON approval_requests (workspace_id, created_at DESC);
