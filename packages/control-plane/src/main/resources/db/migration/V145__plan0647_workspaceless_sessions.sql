-- PLAN-0647 MVP (D-678, 2026-11-09): allow workspace-less sessions.
--
-- Exactly four tables (design §2.1): sessions / chat_runs / context_events / context_projections.
-- DROP NOT NULL only: zero backfill, zero UPDATE/INSERT/DELETE, and the FK / existing composite
-- indexes stay untouched (a FK column may be NULL). chat_runs.workspace_id is the de-normalized
-- copy of sessions.workspace_id (V42 guard), so both become nullable in the same migration.
--
-- Fail-closed boundary (design §2.4): run_checkpoints, agent_graph_checkpoint_lineages,
-- agent_memories, approval_requests and context_source_hashes KEEP workspace_id NOT NULL —
-- checkpoint / memory / approval / RAG / spawn / scheduled are unavailable to pure-chat sessions.
--
-- Rollback (preconditions are machine-checkable; see design §3.2): every
--   SELECT count(*) FROM <table> WHERE workspace_id IS NULL;
-- must be 0, then run the four ALTER COLUMN ... SET NOT NULL statements in reverse order.

ALTER TABLE sessions            ALTER COLUMN workspace_id DROP NOT NULL;
ALTER TABLE chat_runs           ALTER COLUMN workspace_id DROP NOT NULL;
ALTER TABLE context_events      ALTER COLUMN workspace_id DROP NOT NULL;
ALTER TABLE context_projections ALTER COLUMN workspace_id DROP NOT NULL;

-- D47-08: the legacy (workspace_id, user_id, archived, created_at) index cannot serve NULL rows
-- (NULLs are not in a B-tree equality class), so pure-chat session lists get their own partial index.
CREATE INDEX idx_sessions_user_active_no_workspace
    ON sessions (user_id, archived, created_at DESC) WHERE workspace_id IS NULL;
