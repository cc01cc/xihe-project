-- PLAN-0670 M2 (T2.1): cursor pagination for the session message history.
--
-- The read path pages newest-first with a composite `(created_at, id)` cursor. A single
-- `created_at` key is not enough: messages written in the same millisecond would be skipped or
-- duplicated on the next page. This index matches the query exactly, so the LIMIT stops the scan
-- instead of sorting the whole session (deep OFFSET pagination was explicitly rejected).
CREATE INDEX idx_messages_session_created_id ON messages (session_id, created_at, id);
