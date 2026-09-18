-- PLAN-0351 M1 (DDL-5): indexes for unindexed FK child columns.
-- Query faces (evidence/consumers.md, T0.1):
--   * operation_events.item_id / attempt_id: repository lookups ordered by
--     sequence (findByItemIdOrderBySequenceAsc / findByAttemptIdOrderBySequenceAsc)
--     plus the ON DELETE SET NULL FK paths (V2:165-166).
--   * chat_runs.workspace_id: fk_chat_runs_workspace ON DELETE CASCADE (V1:133).
-- No existing index on these tables starts with these columns, so none of the
-- three is redundant with the unique/partial indexes declared in V1/V2.

CREATE INDEX idx_chat_runs_workspace_id ON chat_runs (workspace_id);

CREATE INDEX idx_operation_events_item_sequence ON operation_events (item_id, sequence);

CREATE INDEX idx_operation_events_attempt_sequence ON operation_events (attempt_id, sequence);
