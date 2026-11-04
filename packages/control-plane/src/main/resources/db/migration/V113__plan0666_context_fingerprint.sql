-- PLAN-0666 M1b (BL-269): per-run context fingerprint.
--
-- Stores a JSON document with layered sha256 hashes of the context assembled for the run's FIRST
-- dispatch (design D3). The write is guarded by `context_fingerprint IS NULL`, so a context-overflow
-- re-dispatch of the same run cannot overwrite the first document (v1 boundary, design §2.2).
--
-- NULL means "no document exists": either the row predates this plan (read side reports
-- `pre_plan`) or the run never reached dispatch (`not_dispatched`). The read API never translates
-- that absence into `disabled`/`error` (two-level model, spec §可观测性).
--
-- No index: the column is only ever read by primary key (single-run read / diff by runId), so the
-- existing chat_runs PK index covers it (design D2 / review round-01: 不新增索引).
ALTER TABLE chat_runs ADD COLUMN IF NOT EXISTS context_fingerprint jsonb;

COMMENT ON COLUMN chat_runs.context_fingerprint IS
    'PLAN-0666: layered sha256 fingerprint of the context assembled at first dispatch. '
    'NULL = no document (legacy row -> reason=pre_plan; never dispatched -> reason=not_dispatched). '
    'Stored document status is exactly one of ok/disabled/error; not_dispatched is read-side only.';
