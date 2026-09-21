-- PLAN-0390 M2 (T2.2): Workspace-scoped Job start idempotency.
--
-- The existing uq_session_operations_idempotency (renamed in V33) is
-- (user_id, session_id, idempotency_key) WHERE idempotency_key IS NOT NULL.
-- PostgreSQL treats NULLs as distinct in unique indexes, so a Job created
-- WITHOUT a session (scope=run|workspace, session_id IS NULL) has no
-- idempotency protection at all: two concurrent requests with the same key
-- would each create their own stable root and could each dispatch a process.
--
-- This partial unique index closes that gap for session-less Job roots only.
-- Session-bound requests keep using the existing index (unchanged semantics).

CREATE UNIQUE INDEX uq_ledger_operations_workspace_job_idempotency
    ON ledger_operations (user_id, workspace_id, kind, idempotency_key)
    WHERE idempotency_key IS NOT NULL
      AND session_id IS NULL;
