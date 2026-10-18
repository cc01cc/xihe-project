-- =============================================================================
-- XH Control Plane — PLAN-0502 seam A: run_checkpoints root qualifier
--
-- Adds an explicit root identity to durable checkpoint records so history keeps
-- a stable attribution key. In the current single-root model a Workspace has
-- exactly one root whose identity equals the Workspace identity, so existing
-- rows are backfilled from workspace_id. When a Workspace later gains multiple
-- roots (BL-94), this column carries the per-root key without a contract change
-- plus data migration.
-- =============================================================================

ALTER TABLE run_checkpoints ADD COLUMN root_id VARCHAR(64);

UPDATE run_checkpoints SET root_id = workspace_id::text WHERE root_id IS NULL;

ALTER TABLE run_checkpoints ALTER COLUMN root_id SET NOT NULL;
