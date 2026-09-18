-- PLAN-0351 M1 (DDL-3): a chat operation must be attached to a session.
-- Fresh-path policy (decision #11): no legacy rows are carried, the local
-- database is rebuilt from V1, so the constraint is added in one shot
-- (no NOT VALID -> VALIDATE two-step; that pattern stays only as the generic
-- fallback in spec/migration-contract.md §1).
-- Naming is bound to the current table name (decision #7); the M2 rename
-- batch carries ck_session_operations_* -> ck_ledger_operations_*.

ALTER TABLE session_operations
    ADD CONSTRAINT ck_session_operations_chat_session
    CHECK (kind <> 'chat' OR session_id IS NOT NULL);
