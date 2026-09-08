-- =============================================================================
-- XH Control Plane — Workspace Snapshots (PLAN-275, M1 task 1.4)
--
-- Snapshot records for workspace state capture and revert operations.
-- Snapshots track per-operation file manifests to enable rollback on failure.
--
-- Conventions follow V1__init_schema.sql (PLAN-280):
--   * PostgreSQL native UUID ids, TIMESTAMPTZ time columns, NOW() defaults.
--   * Every FK is explicitly named and declares ON DELETE.
--   * States are VARCHAR (no PostgreSQL enums).
-- =============================================================================

CREATE TABLE workspace_snapshots (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    operation_id      UUID         NOT NULL,
    workspace_id      UUID         NOT NULL,
    state             VARCHAR(32)  NOT NULL DEFAULT 'created',
    manifest_hash     VARCHAR(64),
    storage_ref       TEXT         NOT NULL,
    created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    CONSTRAINT fk_workspace_snapshots_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE CASCADE,
    CONSTRAINT fk_workspace_snapshots_operation FOREIGN KEY (operation_id) REFERENCES session_operations (id) ON DELETE CASCADE,
    CONSTRAINT ck_workspace_snapshots_state CHECK (state IN ('created', 'reverting', 'reverted', 'conflict', 'failed'))
);

CREATE INDEX idx_workspace_snapshots_workspace ON workspace_snapshots (workspace_id);
CREATE INDEX idx_workspace_snapshots_state ON workspace_snapshots (state);

CREATE TABLE workspace_snapshot_files (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    snapshot_id       UUID         NOT NULL,
    relative_path     TEXT         NOT NULL,
    existed_before    BOOLEAN      NOT NULL DEFAULT TRUE,
    content_hash      VARCHAR(64)  NOT NULL,
    size_bytes        BIGINT       NOT NULL DEFAULT 0,
    mode              SMALLINT     DEFAULT 644,
    content_ref       TEXT         NOT NULL,
    created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    CONSTRAINT fk_snapshot_files_snapshot FOREIGN KEY (snapshot_id) REFERENCES workspace_snapshots (id) ON DELETE CASCADE,
    CONSTRAINT uq_snapshot_files_path UNIQUE (snapshot_id, relative_path)
);
