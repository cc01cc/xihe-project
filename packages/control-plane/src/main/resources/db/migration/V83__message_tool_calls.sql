-- PLAN-0572 D1=A: assistant Message carries its Run's tool-call snapshot.
-- JSONB per V32 decision (new JSON columns must be JSONB); nullable so
-- pre-0572 rows stay without cards (no backfill by decision D1).
-- Rollback: ALTER TABLE messages DROP COLUMN tool_calls; (clean rebuild required)

ALTER TABLE messages ADD COLUMN tool_calls JSONB;
