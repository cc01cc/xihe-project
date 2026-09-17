-- =============================================================================
-- XH Control Plane — workspace checkpoint slice projection (PLAN-0339 T0.4)
--
-- The interval projection from V22/V23 is intentionally not migrated. Existing
-- rows and their shadow repositories are discarded before the slice contract is
-- enabled. Dropping and recreating the projection makes the cutover atomic from
-- the CP schema's perspective and leaves no base/end compatibility columns.
-- Runtime remains authoritative for slice refs and shadow Git contents.
-- =============================================================================

DROP TABLE run_checkpoints;

CREATE TABLE run_checkpoints (
    id                      UUID PRIMARY KEY,
    workspace_id            UUID         NOT NULL,
    slice_ref               TEXT,
    captured_at             TIMESTAMPTZ,
    source_run_id           UUID,
    source_session_id       UUID,
    predecessor_ref         TEXT,
    changed_files           TEXT        NOT NULL DEFAULT '[]',
    opaque_nested_repos     TEXT        NOT NULL DEFAULT '[]',
    state                   VARCHAR(32) NOT NULL DEFAULT 'captured',
    unrollable_reason       VARCHAR(64),
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    revert_state             VARCHAR(16) NOT NULL DEFAULT 'none',
    revert_ref               TEXT,
    revert_summary           TEXT,
    reverted_at              TIMESTAMPTZ,
    revert_attempt_count     INTEGER     NOT NULL DEFAULT 0,
    CONSTRAINT fk_run_checkpoints_workspace FOREIGN KEY (workspace_id)
        REFERENCES workspaces (id) ON DELETE CASCADE,
    CONSTRAINT uq_run_checkpoints_workspace_slice UNIQUE (workspace_id, slice_ref),
    CONSTRAINT uq_run_checkpoints_workspace_source_run UNIQUE (workspace_id, source_run_id),
    CONSTRAINT ck_run_checkpoints_state
        CHECK (state IN ('captured', 'abnormal-captured', 'degraded', 'expired')),
    CONSTRAINT ck_run_checkpoints_revert_state
        CHECK (revert_state IN ('none', 'rolled_back', 'partial', 'failed'))
);

CREATE INDEX idx_run_checkpoints_workspace_state_captured
    ON run_checkpoints (workspace_id, state, captured_at DESC);
