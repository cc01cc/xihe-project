-- PLAN-0464 T1.3 + T2.1: ChatRun becomes the single root of the Chat lifecycle.
--
-- Delta-only:
--   1. chat_run_history — append-only transition history for the four writers
--      the plan routes through it (terminal / cancel / recovery / restore),
--      replacing the operation-root mirror that PLAN-0462 decision #2 retires.
--   2. chat_runs.waiting_on_run_id + waiting_tool_call_id — the spawn waiting
--      link moves off operation_items (V44) onto the child ChatRun row.
-- No backfill (design 风险画像 dataMigration: 新增 history 表 + waiting link 列,
-- 无回填): pre-V50 child runs keep a NULL waiting link and the terminal path
-- treats that as legacy data instead of an invariant failure.

CREATE TABLE chat_run_history (
    id               UUID PRIMARY KEY,
    run_id           UUID         NOT NULL REFERENCES chat_runs (id) ON DELETE CASCADE,
    session_id       UUID         NOT NULL,
    sequence         BIGINT       NOT NULL,
    event_type       VARCHAR(24)  NOT NULL,
    source           VARCHAR(24)  NOT NULL,
    actor_type       VARCHAR(16)  NOT NULL,
    from_status      VARCHAR(24),
    to_status        VARCHAR(24)  NOT NULL,
    terminal_outcome VARCHAR(24),
    error_code       VARCHAR(64),
    payload          TEXT,
    created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    CONSTRAINT ck_chat_run_history_event CHECK (
        event_type IN ('terminal', 'cancel', 'recovery', 'restore')),
    CONSTRAINT ck_chat_run_history_source CHECK (
        source IN ('stream', 'cancellation', 'reconciliation', 'recovery')),
    CONSTRAINT ck_chat_run_history_actor CHECK (
        actor_type IN ('system', 'user', 'cp'))
);

CREATE UNIQUE INDEX uq_chat_run_history_run_sequence
    ON chat_run_history (run_id, sequence);

CREATE INDEX idx_chat_run_history_session_created
    ON chat_run_history (session_id, created_at);

-- The waiting link now lives on the child run itself: which parent run it is
-- waiting for and which parent tool call (spawn_agent) the wait belongs to.
-- No FK: child run deletion must not fight a database constraint before the
-- terminal transaction clears the link (same delta contract as V44).
ALTER TABLE chat_runs
    ADD COLUMN waiting_on_run_id UUID;

ALTER TABLE chat_runs
    ADD COLUMN waiting_tool_call_id UUID;

CREATE INDEX idx_chat_runs_waiting_on_run
    ON chat_runs (waiting_on_run_id)
    WHERE waiting_on_run_id IS NOT NULL;
