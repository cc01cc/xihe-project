-- PLAN-0629 follow-up (user ruling 2026-11-04): memory follows the **agent subject**, not the
-- workspace. The same agent principal shares one memory set across every workspace it is bound to;
-- the workspace stops being a data key and survives only as the authorization context of a request.
--
-- Why this is a clean rebuild rather than a de-duplicating merge: the table holds **zero rows**.
--   * V99 created it; V106 (user ruling 2026-11-03) ran `DELETE FROM agent_memories` and the only
--     write faces (the API's MEMORY_WRITE gate and the passive writer) have never been called since.
--   * Measured 2026-11-04 on the dev database (a03-xihe-postgres-1/xihe_1):
--     total=0, live=0, distinct principal=0, distinct workspace=0.
-- So there is nothing to collapse: no "keep the pinned one, else the freshest" survivor logic exists
-- here on purpose — writing it would be dead code that later readers would mistake for a used path.
-- If a future deployment still has rows (e.g. a long-lived instance that skipped V106's window), the
-- statement below still behaves: the new key is strictly coarser, so re-running it after the fact
-- would fail loudly on a duplicate pair instead of silently picking a winner. That is the intended
-- fail-closed outcome for a state this migration was not designed around.
--
-- Order is fixed: an index cannot shrink its column list in place, and the old unique key contains
-- the column being dropped.
--
-- Reversible: re-add `workspace_id UUID NOT NULL REFERENCES workspaces (id) ON DELETE RESTRICT`
-- (rows deleted by this migration are the accepted cost of the ruling, not a migration bug), then
-- restore the two workspace-bearing indexes from V106/V99.

DROP INDEX IF EXISTS uq_agent_memories_dedupe;

DROP INDEX IF EXISTS ix_agent_memories_active_injection;

ALTER TABLE agent_memories DROP COLUMN IF EXISTS workspace_id;

-- D29-32 dedupe, now subject-scoped: the same assertion written twice by the same agent is one row,
-- no matter which workspace the write came from. The partial predicate keeps soft-deleted rows out of
-- the key, so "forget then remember" still works.
CREATE UNIQUE INDEX uq_agent_memories_dedupe
    ON agent_memories (principal_id, content_sha256)
    WHERE deleted_at IS NULL;

-- D29-34 injection order, now subject-scoped: pinned first, then freshest; only active, live rows.
CREATE INDEX ix_agent_memories_active_injection
    ON agent_memories (principal_id, pinned DESC, updated_at DESC)
    WHERE deleted_at IS NULL AND status = 'active';
