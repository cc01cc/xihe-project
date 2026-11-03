-- PLAN-0630 M2 T1.7 (V105): durable wake edge on chat_runs.
--
-- Contract source: PLAN-0630 design.md §3.3 (D30-02) — the wake edge ("which run's output woke
-- this run") is the ONLY new column of this PLAN. The delegation edge is NOT here: spawn runs
-- already carry their parent on waiting_on_run_id (ChatRun.java waiting link), and writing the
-- same fact into two columns would be a second source of truth (D30-01, same ruling as
-- V100__agent_principal_delegation_policy.sql).
--
-- Shape decisions (design.md §3.3):
--   * UUID NULL, no FK — same ruling as V37/V52: run deletion vs terminal transactions must
--     not cascade through this edge, and the ancestor-missing case is judged fail-closed in
--     the service layer (ancestor_missing), not by the DB.
--   * Self-reference (A -> A) is the one cycle shape the DB can fence cheaply and unfakeably;
--     longer cycles are path-scoped and keyed on sessions.agent_principal_id in the service
--     layer (design.md §3.2).
--   * Partial index, same shape as V37:12-14 / V52 / V73.
--   * No depth / chain-root columns: both readings (wake depth, delegation depth) are computed
--     per derivation by walking the edge (<= 10 hops) and are never persisted (D30-03/D30-05).
--
-- Reversible: ALTER TABLE chat_runs DROP COLUMN parent_run_id;  (CHECK + partial index drop
-- with the column; no other object references it).
-- No backfill: historical runs keep parent_run_id = NULL = root, matching the empty-map
-- behaviour the in-memory WakeChainRegistry used to produce (design.md §4.2).

ALTER TABLE chat_runs
    ADD COLUMN parent_run_id UUID;

ALTER TABLE chat_runs
    ADD CONSTRAINT ck_chat_runs_parent_run_not_self
        CHECK (parent_run_id IS NULL OR parent_run_id <> id);

CREATE INDEX idx_chat_runs_parent_run
    ON chat_runs (parent_run_id)
    WHERE parent_run_id IS NOT NULL;
