-- PLAN-0489 决策 #7（contract: PLAN-0486 spec/scheduled-task.md v3.3 §4 session_wakeup）:
-- 空闲会话的定时唤醒改走 CP headless 执行链，其 ChatRun 载体需要可溯源的
-- origin = 'scheduled'（与 user_submission / spawn 并列；挂在既有目标会话上，
-- 非 spawn 子会话）。V39 的 ck_chat_runs_origin 只允许原两值，本迁移放宽 CHECK
-- 加入 'scheduled'；不做历史回填（旧行 provenance 不可推测）。spawn 专用部分唯一
-- 索引 uq_chat_runs_spawn_event_idempotency 不受影响（partial WHERE origin='spawn'）。
--
-- 回滚：ALTER TABLE chat_runs DROP CONSTRAINT ck_chat_runs_origin;
--       ALTER TABLE chat_runs ADD CONSTRAINT ck_chat_runs_origin
--           CHECK (origin IN ('user_submission', 'spawn'));
--       （回滚前需先处置已落库的 scheduled 行，否则 CHECK 重建失败。）

ALTER TABLE chat_runs
    DROP CONSTRAINT ck_chat_runs_origin;

ALTER TABLE chat_runs
    ADD CONSTRAINT ck_chat_runs_origin
        CHECK (origin IN ('user_submission', 'spawn', 'scheduled'));
