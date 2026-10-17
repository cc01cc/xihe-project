-- PLAN-0391 (decision #27): Workspace lifecycle release operations — durable
-- and idempotent store for the user-triggered "release execution resources"
-- command. Dedicated table: the release command is not a Workspace Job, and the
-- former generic ledger (`ledger_operations`) was retired in V56 (PLAN-0467),
-- so no `kind` column exists to reuse.
--
-- Idempotency = request `Idempotency-Key` unique per (user, workspace) while the
-- key is present. Concurrency = at most one active (accepted/running) release
-- per workspace, enforced by a partial unique index (PLAN-0346 lesson: enforce
-- in the DB, not only in application code).

CREATE TABLE workspace_lifecycle_operations (
    id              UUID PRIMARY KEY,
    workspace_id    UUID         NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
    user_id         UUID         NOT NULL REFERENCES users (id),
    idempotency_key VARCHAR(128),
    status          VARCHAR(24)  NOT NULL,
    reason          VARCHAR(32),
    error_code      VARCHAR(64),
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    ended_at        TIMESTAMPTZ,
    CONSTRAINT ck_workspace_lifecycle_operations_status CHECK (
        status IN ('accepted', 'running', 'completed', 'failed', 'interrupted'))
);

-- Idempotent replay: same key returns the existing operation.
CREATE UNIQUE INDEX uq_workspace_lifecycle_operations_idempotency
    ON workspace_lifecycle_operations (user_id, workspace_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL;

-- At most one in-flight release per workspace (different keys included).
CREATE UNIQUE INDEX uq_workspace_lifecycle_operations_active
    ON workspace_lifecycle_operations (workspace_id)
    WHERE status IN ('accepted', 'running');

-- Environment projection + recovery sweeps (latest operation per workspace).
CREATE INDEX idx_workspace_lifecycle_operations_workspace_created_at
    ON workspace_lifecycle_operations (workspace_id, created_at DESC);
