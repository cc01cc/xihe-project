-- PLAN-0467 source-before-delete snapshot:
-- A03-xihe/.local/evidence/xh-plan0467-v55-pre-drop.dump
-- SHA-256: CDAB9B765B616620D5545E4ACD8DCC2C6F5FB8A37A085997ED84F8828FFA6725
-- Isolated V55 schema snapshot and empty-database restore object-inventory check
-- are recorded in plans/PLAN-0467-xh-ledger-retirement/evidence/snapshot-restore.md.
-- No persistent or production database was read or migrated for this snapshot.

-- Remove the V53 transition anchor before dropping its referenced Ledger item table.
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
