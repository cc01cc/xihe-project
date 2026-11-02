-- PLAN-0624 M2 (V94): the wake-schedule projection on scheduled_tasks.
--
-- Contract sources (frozen): PLAN-0624 README Q4 + design rulings D24-05..11
-- (Lead-approved 2026-11-02). `session_participants.wake_config` stays the CONFIG truth
-- (intervalSeconds/jitterSeconds/maxConcurrent); the scheduled_tasks row is its DISPATCH
-- projection, owned by the system (origin='system'), scanned and claimed by the existing
-- ScheduledTaskScanService — no second scheduler.
--
-- Three columns:
--   * trigger_kind gains 'interval' (repeating wake: interval_seconds, no cron, no expiry);
--   * interval_seconds carries the period (>= 60s — sub-minute wake intervals are rejected
--     at the CHECK, not silently rounded by a 30s scan tick);
--   * origin separates system projections from user rows: the UI scheduled-tasks tab lists
--     origin='user' only.
--
-- Existing rows: origin backfills to 'user' via the DEFAULT in the same statement (every
-- pre-V94 row is a user-created task). All widened CHECKs keep every existing combination
-- valid — no data repair pass.
--
-- Reversible: DROP the two columns and restore the four CHECK constraints to their V58 text.

ALTER TABLE scheduled_tasks ADD COLUMN interval_seconds INTEGER;
ALTER TABLE scheduled_tasks ADD COLUMN origin TEXT NOT NULL DEFAULT 'user';

-- Rebuild the trigger vocabulary: + interval.
ALTER TABLE scheduled_tasks DROP CONSTRAINT ck_scheduled_tasks_trigger_kind;
ALTER TABLE scheduled_tasks
    ADD CONSTRAINT ck_scheduled_tasks_trigger_kind
        CHECK (trigger_kind IN ('delay_once', 'cron', 'interval'));

-- Rebuild the target vocabulary: + participant_wake (D24-06: the wake projection).
ALTER TABLE scheduled_tasks DROP CONSTRAINT ck_scheduled_tasks_target_kind;
ALTER TABLE scheduled_tasks
    ADD CONSTRAINT ck_scheduled_tasks_target_kind
        CHECK (target_kind IN ('session_wakeup', 'job_dispatch', 'participant_wake'));

-- interval needs its period and never a cron expression...
ALTER TABLE scheduled_tasks DROP CONSTRAINT ck_scheduled_tasks_cron_expr;
ALTER TABLE scheduled_tasks
    ADD CONSTRAINT ck_scheduled_tasks_cron_expr CHECK (
        (trigger_kind = 'cron' AND cron_expr IS NOT NULL) OR
        (trigger_kind = 'delay_once' AND cron_expr IS NULL) OR
        (trigger_kind = 'interval' AND cron_expr IS NULL));

-- ...and never an expiry (wake stops when the participant is disabled/deleted, not on a clock).
ALTER TABLE scheduled_tasks DROP CONSTRAINT ck_scheduled_tasks_expires_at;
ALTER TABLE scheduled_tasks
    ADD CONSTRAINT ck_scheduled_tasks_expires_at CHECK (
        (trigger_kind = 'delay_once' AND expires_at IS NOT NULL) OR
        (trigger_kind = 'cron' AND expires_at IS NULL) OR
        (trigger_kind = 'interval' AND expires_at IS NULL));

-- A wake projection always targets its session (TOCTOU revalidation happens at dispatch).
ALTER TABLE scheduled_tasks DROP CONSTRAINT ck_scheduled_tasks_session_target;
ALTER TABLE scheduled_tasks
    ADD CONSTRAINT ck_scheduled_tasks_session_target CHECK (
        (target_kind = 'session_wakeup') OR
        (target_kind = 'participant_wake' AND target_session_id IS NOT NULL AND prompt IS NULL) OR
        (target_kind = 'job_dispatch' AND target_session_id IS NULL AND prompt IS NULL));

-- ...and carries the participant identity in payload (never a fixed prompt).
ALTER TABLE scheduled_tasks DROP CONSTRAINT ck_scheduled_tasks_prompt;
ALTER TABLE scheduled_tasks
    ADD CONSTRAINT ck_scheduled_tasks_prompt CHECK (
        (target_kind = 'session_wakeup' AND prompt IS NOT NULL) OR
        (target_kind = 'participant_wake' AND payload IS NOT NULL) OR
        (target_kind = 'job_dispatch' AND payload IS NOT NULL));

-- The interval contract: required and coarse-grained when interval, absent otherwise.
ALTER TABLE scheduled_tasks
    ADD CONSTRAINT ck_scheduled_tasks_interval CHECK (
        (trigger_kind = 'interval' AND interval_seconds IS NOT NULL AND interval_seconds >= 60) OR
        (trigger_kind <> 'interval' AND interval_seconds IS NULL));
