-- PLAN-0376: durable host-side Workspace import records.

CREATE TABLE IF NOT EXISTS workspace_imports (
    id UUID PRIMARY KEY,
    workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    owner_id VARCHAR(36) NOT NULL,
    source_path TEXT NOT NULL,
    exclude_rules TEXT NOT NULL DEFAULT '[]',
    idempotency_key VARCHAR(255) NOT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'queued',
    files_scanned BIGINT NOT NULL DEFAULT 0,
    files_copied BIGINT NOT NULL DEFAULT 0,
    files_skipped BIGINT NOT NULL DEFAULT 0,
    bytes_copied BIGINT NOT NULL DEFAULT 0,
    bytes_skipped BIGINT NOT NULL DEFAULT 0,
    current_file_path TEXT,
    error_code VARCHAR(96),
    error_detail TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    CONSTRAINT ck_workspace_imports_status CHECK (
        status IN ('queued', 'running', 'completed', 'cancelled', 'failed')
    ),
    CONSTRAINT uq_workspace_imports_owner_idempotency UNIQUE (owner_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_workspace_imports_workspace_created
    ON workspace_imports (workspace_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_workspace_imports_active
    ON workspace_imports (workspace_id, status)
    WHERE status IN ('queued', 'running');
