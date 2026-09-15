-- =============================================================================
-- XH Control Plane — Run checkpoint revert bookkeeping (PLAN-0328 M3 W2)
--
-- The Runtime remains authoritative for the rollback refs; this migration adds
-- the CP-side durable projection of a revert attempt:
--   revert_state         — none | rolled_back | partial | failed
--                          (rolled_back: every listed item restored/deleted with
--                           no conflict and no failure; partial: conflicts skipped
--                           and/or per-item failures; none: no revert attempted)
--   revert_ref           — Runtime audit ref refs/xihe/<runId>/rollback/<epochMs>
--   revert_summary       — JSON text: the same ledger summary appended to the run's
--                          operation item ({marker, checkpointId, runId, revertRef,
--                          counts, conflicts[<=20], allowedBy, reason})
--   reverted_at          — last attempt timestamp
--   revert_attempt_count — monotonic attempt counter (records every accepted revert,
--                          including partial ones; drives ledger identity)
--
-- Conventions follow V22 / V1__init_schema.sql (PLAN-280): VARCHAR states with a
-- CHECK allowlist, TIMESTAMP WITH TIME ZONE, NOT NULL with defaults. The DDL and
-- constraint syntax is compatible with PostgreSQL 17 and H2 (PostgreSQL mode).
--
-- Rollback: ALTER TABLE run_checkpoints DROP CONSTRAINT ck_run_checkpoints_revert_state;
--           ALTER TABLE run_checkpoints DROP COLUMN revert_state / revert_ref /
--             revert_summary / reverted_at / revert_attempt_count;
-- =============================================================================

ALTER TABLE run_checkpoints
    ADD COLUMN revert_state VARCHAR(16) NOT NULL DEFAULT 'none';

ALTER TABLE run_checkpoints
    ADD CONSTRAINT ck_run_checkpoints_revert_state
        CHECK (revert_state IN ('none', 'rolled_back', 'partial', 'failed'));

ALTER TABLE run_checkpoints
    ADD COLUMN revert_ref TEXT;

ALTER TABLE run_checkpoints
    ADD COLUMN revert_summary TEXT;

ALTER TABLE run_checkpoints
    ADD COLUMN reverted_at TIMESTAMP WITH TIME ZONE;

ALTER TABLE run_checkpoints
    ADD COLUMN revert_attempt_count INTEGER NOT NULL DEFAULT 0;
