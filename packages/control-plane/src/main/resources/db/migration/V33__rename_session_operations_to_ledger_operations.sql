-- PLAN-0351 M2 (DDL-12): rename session_operations -> ledger_operations.
--
-- The table is the audit root of one logical user/system action, not a
-- session-scoped fact (session_id/run_id nullable; kind covers
-- workspace_lifecycle/job/system), so it follows the ledger family naming
-- (operation_items / operation_events / operation_attempts /
-- operation_extensions). Fresh-path policy (decision #11): the local database
-- is rebuilt from V1, so the rename is a single forward migration.
--
-- V2/V3/V4 (and V30) stay untouched: the historical names live on there and
-- the old-name -> new-name mapping is registered in the plan spec
-- (plans/PLAN-0351-XH-schema-cleanup/spec/migration-contract.md §5).
--
-- This migration renames the table plus all 14 objects carrying the old
-- prefix: PK x1, FK x4, CHECK x5 (4 from V2 + the V30 chat/session CHECK),
-- unique indexes x2, plain indexes x2. Child-side FK constraint names
-- (fk_operation_items_operation etc.) intentionally keep their names;
-- PostgreSQL rewrites their referenced-table pointer with the rename.

ALTER TABLE session_operations RENAME TO ledger_operations;

ALTER TABLE ledger_operations
    RENAME CONSTRAINT session_operations_pkey TO ledger_operations_pkey;

ALTER TABLE ledger_operations
    RENAME CONSTRAINT fk_session_operations_session TO fk_ledger_operations_session;
ALTER TABLE ledger_operations
    RENAME CONSTRAINT fk_session_operations_workspace TO fk_ledger_operations_workspace;
ALTER TABLE ledger_operations
    RENAME CONSTRAINT fk_session_operations_user TO fk_ledger_operations_user;
ALTER TABLE ledger_operations
    RENAME CONSTRAINT fk_session_operations_run TO fk_ledger_operations_run;

ALTER TABLE ledger_operations
    RENAME CONSTRAINT ck_session_operations_kind TO ck_ledger_operations_kind;
ALTER TABLE ledger_operations
    RENAME CONSTRAINT ck_session_operations_source TO ck_ledger_operations_source;
ALTER TABLE ledger_operations
    RENAME CONSTRAINT ck_session_operations_actor_type TO ck_ledger_operations_actor_type;
ALTER TABLE ledger_operations
    RENAME CONSTRAINT ck_session_operations_status TO ck_ledger_operations_status;
ALTER TABLE ledger_operations
    RENAME CONSTRAINT ck_session_operations_chat_session TO ck_ledger_operations_chat_session;

ALTER INDEX uq_session_operations_idempotency RENAME TO uq_ledger_operations_idempotency;
ALTER INDEX uq_session_operations_run RENAME TO uq_ledger_operations_run;
ALTER INDEX idx_session_operations_session_time RENAME TO idx_ledger_operations_session_time;
ALTER INDEX idx_session_operations_workspace_time RENAME TO idx_ledger_operations_workspace_time;
