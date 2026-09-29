-- PLAN-0409 design #22 (2026-09-29 user ruling): durable delete-intent barrier.
-- DELETE records this marker inside the same short lock as the copying
-- precheck; fork claims and mutation guards reject the session while it is
-- set, so cancellation/job-close side effects can run outside any lock
-- without racing a new fork claim. The marker is irreversible (no undo) and
-- disappears together with the row in the final delete transaction.
ALTER TABLE sessions ADD COLUMN delete_requested_at TIMESTAMPTZ;
