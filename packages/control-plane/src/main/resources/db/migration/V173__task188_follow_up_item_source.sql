-- V173 (task-188 MVP⑤ S3): steer attribution on the existing Follow-up FIFO.
--
-- Number allocation (checks at implementation time, 2026-11-18): develop tree max = V171, V172
-- taken by this same lane's S2 batch; 'git log --all --diff-filter=A -- <dir>/V173*' = 0 hits;
-- 'git worktree list' = this checkout only. => V173. Registered in
-- internal/A03-xihe/docs/migration-keys / migration-numbers.md §0 (§4 in the same batch).
--
-- Design (D-1821 默认③): a steer REUSES the V49 durable FIFO — no second queue, no new table.
-- Two attribution columns answer "who put this here":
--   source_kind     'human' (default; every pre-V173 row and every ordinary follow-up) |
--                   'agent_steer' (the Lead mid-run 指挥插话, POST /sessions/{child}/steers)
--   from_session_id the steering session (the Lead's session) for agent_steer; NULL for human.
--
-- Deliberately NO CHECK tying source_kind to from_session_id: the row is written by two writers
-- (FollowUpQueueService.enqueue for human rows, SteerService for agent rows) and a CHECK would only
-- re-encode "the writer sets both" — it cannot stop a future third writer, and it WOULD make a
-- partial-column future migration (backfill then add) impossible. The read face treats a missing
-- source_kind as 'human' (that is what the DEFAULT does for every existing row), so the vocabulary
-- stays extensible.
--
-- Index: the UI renders a "来自 Lead" badge off the item row it already reads (snapshot), so no new
-- read path is needed; the partial index exists only for operators counting agent steers.

ALTER TABLE session_follow_up_items
    ADD COLUMN source_kind VARCHAR(16) NOT NULL DEFAULT 'human',
    ADD COLUMN from_session_id UUID,
    ADD CONSTRAINT ck_session_follow_up_items_source_kind
        CHECK (source_kind IN ('human', 'agent_steer'));
-- No FK on from_session_id on purpose: a steering Session may be deleted while the steer row stays
-- (the child's history must not lose its attribution), and V49's session FK already cascades the
-- queue row itself when the CHILD session goes away.

CREATE INDEX idx_session_follow_up_items_agent_steer
    ON session_follow_up_items (from_session_id)
    WHERE source_kind = 'agent_steer';

COMMENT ON COLUMN session_follow_up_items.source_kind IS
    'task-188 S3 steer attribution: human (default, every pre-V173 row) | agent_steer (Lead 指挥插话)';
COMMENT ON COLUMN session_follow_up_items.from_session_id IS
    'the steering Session for agent_steer rows; NULL for human rows (no FK: attribution survives the steering Session)';
