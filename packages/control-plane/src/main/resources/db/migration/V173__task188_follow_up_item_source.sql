-- V173 (task-188 MVP⑤ S3): steer attribution on the existing Follow-up FIFO.
--
-- Number allocation (checks at implementation time, 2026-11-18): develop tree max = V171; V172
-- taken by this same lane's S2 batch; 'git log --all --diff-filter=A -- <dir>/V173*' = 0 hits;
-- 'git worktree list' = this checkout only. => V173. Registered in migration-numbers.md §0/§4.
--
-- Design (D-1821 默认③): a steer REUSES the V49 durable FIFO — no second queue, no new table.
-- Three added columns. Two answer "who put this here":
--   source_kind     NULL (every pre-V173 row and every ordinary human follow-up) |
--                   'human' | 'agent_steer' (the Lead's mid-run 指挥插话)
--   from_session_id the steering Session (the Lead's session) for agent_steer; NULL otherwise.
-- The third is advisory bookkeeping (see its COMMENT below):
--   expected_revision the board revision the Lead assumed (D-1830).
--
-- NULL means human on purpose (the plan draft §1.5 shape, and the UI contract: nothing renders a
-- badge for null — DEV-032 "no attribution renders no badge, never unknown"). No DEFAULT and no
-- backfill: an existing row keeps saying exactly what it always said, i.e. nothing.
--
-- Two CHECKs, and the second is the one that matters: it is an IMPLICATION, not a biconditional.
--   ck_follow_up_source_kind          — closed vocabulary, NULL allowed
--   ck_follow_up_steer_requires_source — agent_steer REQUIRES from_session_id; it deliberately does
--                                       NOT forbid a human row carrying one. A future writer may
--                                       attribute a human row to the session that asked for it, and
--                                       that must stay legal without a migration.
--
-- No FK on from_session_id: the steering Session may be deleted while the steer row stays (the
-- child's history must not lose its attribution). V49's own session FK already cascades the queue
-- row away when the CHILD Session goes away.

ALTER TABLE session_follow_up_items
    ADD COLUMN source_kind         varchar(16),
    ADD COLUMN from_session_id     uuid,
    ADD COLUMN expected_revision   integer;

ALTER TABLE session_follow_up_items
    ADD CONSTRAINT ck_follow_up_source_kind
        CHECK (source_kind IS NULL OR source_kind IN ('human', 'agent_steer')),
    ADD CONSTRAINT ck_follow_up_steer_requires_source
        CHECK (source_kind IS DISTINCT FROM 'agent_steer' OR from_session_id IS NOT NULL),
    ADD CONSTRAINT ck_follow_up_expected_revision
        CHECK (expected_revision IS NULL OR expected_revision >= 0);

-- Operators count agent steers; the UI needs no new read path (it already reads the item row).
CREATE INDEX idx_session_follow_up_items_agent_steer
    ON session_follow_up_items (from_session_id)
    WHERE source_kind = 'agent_steer';

COMMENT ON COLUMN session_follow_up_items.source_kind IS
    'task-188 S3 steer attribution: NULL = pre-existing/human Follow-up | human | agent_steer (Lead 指挥插话)';
COMMENT ON COLUMN session_follow_up_items.from_session_id IS
    'the steering Session for agent_steer rows; NULL otherwise (no FK: attribution survives the steering Session)';
COMMENT ON COLUMN session_follow_up_items.expected_revision IS
    'ADVISORY-ONLY (D-1830): the board revision the steering Lead assumed; echoed for the reader, never a queue CAS gate. It gets its own column because tool_timeouts is a tool-name-to-seconds map that admission actually reads — parking an unrelated integer there would fake a tool called "expectedRevision".';