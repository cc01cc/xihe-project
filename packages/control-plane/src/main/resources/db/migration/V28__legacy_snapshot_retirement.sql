-- PLAN-0357: retire the legacy snapshot implementation (V4/V5 artifacts).
-- The legacy tables are empty and unused (evidence/legacy-inventory.md); this
-- migration is a pure cleanup after PLAN-0339 completed the slice model.
-- Not touched: run_checkpoints and V22/V23/V26/V27, shadow Git, ledger history.

DROP INDEX idx_approval_requests_snapshot;

ALTER TABLE approval_requests DROP COLUMN snapshot_id;
ALTER TABLE approval_requests DROP COLUMN policy_class;

DROP TABLE workspace_snapshot_files;
DROP TABLE workspace_snapshots;
