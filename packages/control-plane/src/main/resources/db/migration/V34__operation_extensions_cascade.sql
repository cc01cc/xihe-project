-- PLAN-0367 decision #2 (DDL-13): operation_extensions target FKs SET NULL -> CASCADE.
--
-- Why: the SET NULL rewrite collided with ck_operation_extensions_target (at
-- least one target must stay non-null): deleting a session cascades
-- ledger_operations -> operation_items/operation_attempts, the child
-- extensions were rewritten to NULL and the CHECK failed, rolling back the
-- whole session-delete transaction. Reproduced on both the real local database
-- and a scratch database in PLAN-0352 M0 — see
-- plans/archive/20260919/PLAN-0352-XH-runtime-agent-cleanup/evidence/lif1-current-state.md §6.
--
-- CASCADE matches the ledger chain semantics already frozen in V2 (session hard
-- delete removes the whole chain); the CHECK stays. Accepted trade-off
-- (PLAN-0367 decision #2): llm_usage / job_state / mcp_call extension archives
-- are deleted together with the ledger rows they annotate; read paths do not
-- depend on the SET NULL branch.

ALTER TABLE operation_extensions
    DROP CONSTRAINT fk_operation_extensions_item,
    ADD CONSTRAINT fk_operation_extensions_item
        FOREIGN KEY (item_id) REFERENCES operation_items (id) ON DELETE CASCADE;

ALTER TABLE operation_extensions
    DROP CONSTRAINT fk_operation_extensions_attempt,
    ADD CONSTRAINT fk_operation_extensions_attempt
        FOREIGN KEY (attempt_id) REFERENCES operation_attempts (id) ON DELETE CASCADE;
