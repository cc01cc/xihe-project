-- =============================================================================
-- XH Control Plane — Runtime Job Registry (PLAN-274, M2 task 2.0)
--
-- Durable job records for long-running runtime operations (sandbox commands,
-- workspace lifecycle tasks). Jobs transition through a state machine:
--   queued → running → completed|failed|cancelled
--   queued|running → orphaned (when owner disconnects)
--
-- Conventions follow V1__init_schema.sql (PLAN-280):
--   * PostgreSQL native UUID ids, TIMESTAMPTZ time columns, NOW() defaults.
--   * Every FK is explicitly named and declares ON DELETE.
--   * States are VARCHAR (no PostgreSQL enums).
-- =============================================================================

CREATE TABLE runtime_jobs (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    operation_id      UUID         NOT NULL,
    operation_item_id UUID         NOT NULL,
    workspace_id      UUID         NOT NULL,
    run_id            UUID,
    status            VARCHAR(32)  NOT NULL DEFAULT 'queued',
    command_summary   TEXT,
    pid               BIGINT,
    exit_code         INTEGER,
    error_code        VARCHAR(64),
    output_available  BOOLEAN      NOT NULL DEFAULT FALSE,
    output_ref        TEXT,
    owner_id          VARCHAR(128),
    lease_expires_at  TIMESTAMPTZ,
    started_at        TIMESTAMPTZ,
    finished_at       TIMESTAMPTZ,
    orphaned_at       TIMESTAMPTZ,
    created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    CONSTRAINT fk_runtime_jobs_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE CASCADE,
    CONSTRAINT fk_runtime_jobs_operation FOREIGN KEY (operation_id) REFERENCES session_operations (id) ON DELETE CASCADE,
    CONSTRAINT fk_runtime_jobs_operation_item FOREIGN KEY (operation_item_id) REFERENCES operation_items (id) ON DELETE CASCADE,
    CONSTRAINT fk_runtime_jobs_chat_run FOREIGN KEY (run_id) REFERENCES chat_runs (id) ON DELETE SET NULL,
    CONSTRAINT ck_runtime_jobs_status CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled', 'orphaned'))
);

CREATE INDEX idx_runtime_jobs_workspace ON runtime_jobs (workspace_id);
CREATE INDEX idx_runtime_jobs_status ON runtime_jobs (status);
CREATE INDEX idx_runtime_jobs_owner ON runtime_jobs (owner_id) WHERE owner_id IS NOT NULL;
CREATE INDEX idx_runtime_jobs_active ON runtime_jobs (workspace_id, status) WHERE status IN ('queued', 'running');
