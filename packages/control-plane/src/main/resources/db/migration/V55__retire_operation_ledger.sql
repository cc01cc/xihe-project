-- PLAN-0467 source-before-delete snapshot:
-- A03-xihe/.local/evidence/xh-plan0467-v54-pre-drop.dump
-- SHA-256: 8E53DCD83137F897B786CE68A51ABFCC96ECB128CEB94C1367AED16F777938AF
-- Full V54 database snapshot and empty-database restore row-count verification are
-- recorded in plans/PLAN-0467-xh-ledger-retirement/evidence/snapshot-restore.md.

-- Remove the V52 transition anchor before dropping its referenced Ledger item table.
ALTER TABLE workspace_jobs DROP CONSTRAINT workspace_jobs_operation_item_id_fkey;
DROP INDEX uq_workspace_jobs_operation_item;
ALTER TABLE workspace_jobs DROP COLUMN operation_item_id;

-- Drop referring Ledger tables before their parents; no CASCADE hides dependencies.
DROP TABLE operation_events;
DROP TABLE diagnostic_artifacts;
DROP TABLE operation_extensions;
DROP TABLE operation_attempts;
DROP TABLE operation_items;
DROP TABLE ledger_operations;
