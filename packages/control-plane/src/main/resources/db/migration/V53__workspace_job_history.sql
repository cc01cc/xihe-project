-- PLAN-0465 T1.3: workspace_job_history — append-only transition history for one
-- Workspace Job (PLAN-0462 decision #8: every domain that audits state flow owns
-- its own history; "current state + logs" is not acceptable).
--
-- The six event_type values are the six write branches of JobStateService /
-- WorkspaceJobStartService:
--   start       — row created (initial status recorded in to_status)
--   running     — dispatch confirmed (pending → running)
--   settle      — terminal settle from Runtime facts (succeeded / timeout)
--   cancel      — cancelled (user cancel, scope closure, MCP cancel tool)
--   orphaned    — fail-closed convergence (destroy window / job missing / failed)
--   interrupted — Runtime restart / dispatch failure收口
-- Rows are never updated; sequence is max+1 under the workspace_jobs row lock.

CREATE TABLE workspace_job_history (
    id            UUID PRIMARY KEY,
    job_id        UUID         NOT NULL REFERENCES workspace_jobs (id) ON DELETE CASCADE,
    sequence      BIGINT       NOT NULL,
    event_type    VARCHAR(24)  NOT NULL,
    from_status   VARCHAR(24),
    to_status     VARCHAR(24)  NOT NULL,
    cancel_reason VARCHAR(64),
    error_code    VARCHAR(64),
    payload       TEXT,
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    CONSTRAINT ck_workspace_job_history_event CHECK (
        event_type IN ('start', 'running', 'settle', 'cancel', 'orphaned', 'interrupted'))
);

CREATE UNIQUE INDEX uq_workspace_job_history_job_sequence
    ON workspace_job_history (job_id, sequence);

CREATE INDEX idx_workspace_job_history_job_created
    ON workspace_job_history (job_id, created_at);
