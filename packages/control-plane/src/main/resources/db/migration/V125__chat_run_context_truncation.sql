-- PLAN-0670 M2c / BL-293: durable trace of the inbound context truncation of one ChatRun.
--
-- The Agent reports the object on the terminal `done` SSE event
-- (`done.agentContextTruncation`, same wire shape as `Truncation.to_wire()`: dropped/kept
-- messages+bytes, limits, strategy). CP relays it unchanged to the UI and now persists the exact
-- object here for auditing/statistics (BL-293). NULL = the run did not truncate; never an empty
-- object / all-zero row. No read API in this batch (BL-292 owns UI consumption).
ALTER TABLE chat_runs ADD COLUMN context_truncation jsonb;
