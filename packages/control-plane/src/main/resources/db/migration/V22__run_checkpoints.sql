-- =============================================================================
-- XH Control Plane — Run checkpoints (PLAN-0328 M2 W3)
--
-- CP-side projection of Runtime-owned Run checkpoints (shadow git). One row per
-- (run_id, workspace_id); the Runtime remains authoritative for the refs.
--
-- States: base      — baseline established, the Run may still mutate
--         sealed    — end ref written, change set frozen
--         unsealed  — base without end (Runtime sweep pending)
--         degraded  — establishment failed; unrollable_reason explains why
--                     (LEASE_HELD | UNAVAILABLE)
--         expired   — retention removed the refs; row kept for audit
--
-- Conventions follow V1__init_schema.sql (PLAN-280): PostgreSQL native UUID ids,
-- TIMESTAMPTZ time columns, NOW() defaults; states are VARCHAR (no enums).
-- =============================================================================

CREATE TABLE run_checkpoints (
    id                      UUID PRIMARY KEY,
    run_id                  UUID         NOT NULL,
    workspace_id            UUID         NOT NULL,
    state                   VARCHAR(32)  NOT NULL DEFAULT 'base',
    base_ref                TEXT,
    end_ref                 TEXT,
    changed_files           TEXT,
    sealed_with_live_jobs   BOOLEAN      NOT NULL DEFAULT FALSE,
    sealed_after_abnormal   BOOLEAN      NOT NULL DEFAULT FALSE,
    unrollable_reason       VARCHAR(64),
    created_at              TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    sealed_at               TIMESTAMPTZ,
    updated_at              TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    CONSTRAINT fk_run_checkpoints_workspace FOREIGN KEY (workspace_id)
        REFERENCES workspaces (id) ON DELETE CASCADE,
    CONSTRAINT uq_run_checkpoints_run_workspace UNIQUE (run_id, workspace_id),
    CONSTRAINT ck_run_checkpoints_state
        CHECK (state IN ('base', 'sealed', 'unsealed', 'degraded', 'expired'))
);

CREATE INDEX idx_run_checkpoints_workspace_state ON run_checkpoints (workspace_id, state);

-- Ledger checkpoint markers use kind='checkpoint' (PLAN-0328 M2 W3): extend the
-- V10 allowlist (llm_usage included) so the audit marker can be appended to a
-- run's operation without dropping earlier kinds.
ALTER TABLE operation_items DROP CONSTRAINT ck_operation_items_kind;
ALTER TABLE operation_items ADD CONSTRAINT ck_operation_items_kind
    CHECK (kind IN ('chat', 'tool_call', 'approval', 'job', 'workspace_lifecycle',
                    'system', 'other', 'llm_usage', 'checkpoint'));
