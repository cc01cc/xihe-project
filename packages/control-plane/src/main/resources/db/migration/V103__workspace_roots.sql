-- PLAN-0639 M1 (V103): workspace roots — the multi-root workspace contract.
--
-- Contract sources (frozen, do not re-litigate here):
--   * PLAN-0639 design.md §2 (DDL shape), §D39-3 (runtime CRUD), §D39-5b (nested roots).
--   * Root[0] = primary root with id = workspace.id (primary-root invariant).
--   * Shadow repo per root: <hostRoot>/.xihe-shadow/<rootId>.git (D-1, per-root shadow).
--   * run_checkpoints.root_id is a LOGICAL reference (V76), intentionally NO FK here —
--     backfill ordering + PLAN-0630 same-batch table change.
--
-- Deliberately NOT here: no FK from run_checkpoints to workspace_roots; no GC for archived
-- shadow repos (D39-11: in-place retention, no cleanup strategy in M1); no root-level role
-- or authorization columns (workspace-level authorization unchanged).
--
-- Reversible: DROP TABLE workspace_roots;  (no other object touched)

CREATE TABLE workspace_roots (
    id            UUID PRIMARY KEY,
    -- owning workspace; RESTRICT keeps a root row from dangling when the workspace row is
    -- hard-deleted (workspace deletion is itself soft via deleted_at).
    workspace_id  UUID        NOT NULL REFERENCES workspaces (id) ON DELETE RESTRICT,
    -- display/parse order within this workspace; 0-based.  Root[0] (position = 0) has
    -- id = workspace_id (primary-root invariant, design.md §2).
    position      INT         NOT NULL CHECK (position >= 0),
    -- optional display name; pure UI label, never a path component (design.md §2).
    alias         VARCHAR(128),
    -- canonical host absolute directory, stored lowercased by CP before INSERT (design.md §2).
    host_path     TEXT        NOT NULL,
    -- actor that created this root row: 'user:<uuid>' | 'system:migration'.
    created_by    VARCHAR(64) NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- soft-delete marker; NULL = active.  Soft-deleted rows are retained for audit and to
    -- keep run_checkpoints.root_id resolvable (design.md §D39-3).
    deleted_at    TIMESTAMPTZ
);

-- Partial unique indexes: active rows must not collide on (workspace, canonical-path) or
-- (workspace, position).  Soft-deleted rows are excluded from both constraints.
CREATE UNIQUE INDEX uq_workspace_roots_active_path
    ON workspace_roots (workspace_id, lower(host_path))
    WHERE deleted_at IS NULL;

CREATE UNIQUE INDEX uq_workspace_roots_active_position
    ON workspace_roots (workspace_id, position)
    WHERE deleted_at IS NULL;

-- Fast lookup of active roots per workspace (execution-spec assembly, CP read path).
CREATE INDEX idx_workspace_roots_workspace
    ON workspace_roots (workspace_id)
    WHERE deleted_at IS NULL;

-- Backfill: one root row per existing direct-attach workspace (D39-7 lazy migration).
-- id = workspace_id makes root[0].id = workspace.id hold for every pre-existing workspace
-- without touching run_checkpoints.root_id (V76 already stores workspace_id for those rows).
INSERT INTO workspace_roots (id, workspace_id, position, host_path, created_by)
SELECT id, id, 0, host_path, 'system:migration'
FROM workspaces
WHERE storage_mode = 'direct_attach'
  AND host_path IS NOT NULL;

-- Multi-root run slice uniqueness: a run that touches N roots produces N slice rows.
-- Extend the existing uniqueness key with root_id so per-root slices do not collide.
-- (Existing single-root rows have root_id = workspace_id; they remain valid under the new key.)
ALTER TABLE run_checkpoints
    DROP CONSTRAINT uq_run_checkpoints_workspace_source_run;

ALTER TABLE run_checkpoints
    ADD CONSTRAINT uq_run_checkpoints_workspace_root_source_run
    UNIQUE (workspace_id, root_id, source_run_id);
