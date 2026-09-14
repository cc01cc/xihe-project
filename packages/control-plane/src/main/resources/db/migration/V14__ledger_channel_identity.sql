-- =============================================================================
-- XH Control Plane — Ledger channel identity (PLAN-0326, decisions #4/#9)
--
-- 1) Drop the dormant `runtime_jobs` registry (PLAN-274 M2): no writer/caller
--    anywhere in the codebase (DEV-018 debt #11). A future long-task batch
--    (J-3/P1-10) will redesign its own durable store.
-- 2) Retire the "one row per tool call" identity. Since v3 (decision #9) the
--    ledger unit is a CHANNEL FACT: the relay records agent-side facts and the
--    gateway records dispatch-side facts as separate rows sharing the same
--    tool_call_id. `source` becomes part of the row identity.
--
-- History note (2026-09-14 user decision): dev-state databases are disposable.
-- No data backfill / reconciliation step; stale local DBs are dropped via
-- `mise run dev:reset -- -Reset` per the AGENTS fresh-baseline rule.
-- =============================================================================

DROP TABLE IF EXISTS runtime_jobs;

DROP INDEX IF EXISTS uq_operation_items_operation_tool_call;

CREATE UNIQUE INDEX uq_operation_items_operation_source_tool_call
    ON operation_items (operation_id, source, tool_call_id) WHERE tool_call_id IS NOT NULL;
