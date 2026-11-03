-- PLAN-0629 M1-5 (user ruling 2026-11-03): memory is no longer classified into `profile` / `fact`.
--
-- DESTRUCTIVE BY USER RULING 2026-11-03: the classification lived only in this column (one value per
-- row), so it cannot be back-filled and the ruling is to clear the table rather than pretend to
-- migrate history. Deliberately short: no dedupe-by-survivor logic, no "keep the pinned/newest row"
-- branch, no rewrite of history. The user accepted "history memories are gone" as the cost.
--
-- Order is fixed and matters:
--   1. clear the rows (the old unique key contains the column being dropped);
--   2. drop the old unique key (an index cannot shrink its column list in place);
--   3. drop the column;
--   4. recreate the dedupe key over (principal, workspace, content_sha256).
-- The partial predicate is kept: a soft-deleted (archived) row must not block a re-write (V99 D29-32).
--
-- Reversible: re-add `type TEXT NOT NULL DEFAULT 'fact'` + the old index. The deleted rows are NOT
-- recoverable — that is the accepted cost of the ruling, not a migration bug.
DELETE FROM agent_memories;

DROP INDEX IF EXISTS uq_agent_memories_dedupe;

ALTER TABLE agent_memories DROP COLUMN IF EXISTS type;

CREATE UNIQUE INDEX uq_agent_memories_dedupe
    ON agent_memories (principal_id, workspace_id, content_sha256)
    WHERE deleted_at IS NULL;
