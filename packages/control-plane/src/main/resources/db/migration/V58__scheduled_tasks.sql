-- PLAN-0489 (contract: PLAN-0486 spec/scheduled-task.md v3.3 §1): scheduled_tasks
-- — user/agent-visible timed triggers: delay_once + cron, firing claim state,
-- missed/expired disposition model (0486 D1-D4, B1-B3, #9/#10).
--
-- * trigger_kind split: cron rows carry cron_expr (5-field, 1-min grain); delay_once
--   rows carry expires_at = created_at + TTL (7d) and never a cron_expr.
-- * target split: session_wakeup requires target_session_id (nullable after a hard
--   session delete — NULL means target_gone and the scan marks the row missed, B2)
--   plus prompt; job_dispatch carries payload JSONB (command/args/cwd/timeout/scope)
--   and must not reference a session.
-- * status = scheduled | firing | missed | expired | cancelled | completed;
--   firing is the CAS claim slot (B3) — one row claimed at a time per task.
-- * missed_count = consecutive missed rounds under E1 stop-scheduling semantics (B1),
--   cleared on user disposition; missed_reason records why (target_gone /
--   dispatch_failed / overdue_grace).
-- * user_id = creator principal (human or agent account, 0486 #9); createdBy on the
--   read DTO is projected from users/principals, not stored twice.
-- * Reversible: DROP TABLE scheduled_tasks (new table only — no data migration).

CREATE TABLE scheduled_tasks (
    id                UUID PRIMARY KEY,
    workspace_id      UUID         NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
    user_id           UUID         NOT NULL REFERENCES users (id),
    trigger_kind      VARCHAR(16)  NOT NULL,
    cron_expr         VARCHAR(120),
    timezone          VARCHAR(64)  NOT NULL,
    target_kind       VARCHAR(24)  NOT NULL,
    target_session_id UUID REFERENCES sessions (id) ON DELETE SET NULL,
    prompt            TEXT,
    payload           JSONB,
    status            VARCHAR(16)  NOT NULL,
    next_fire_at      TIMESTAMPTZ  NOT NULL,
    expires_at        TIMESTAMPTZ,
    missed_count      INTEGER      NOT NULL DEFAULT 0,
    last_missed_at    TIMESTAMPTZ,
    missed_reason     VARCHAR(64),
    last_run_id       UUID,
    cancel_reason     VARCHAR(64),
    created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    CONSTRAINT ck_scheduled_tasks_trigger_kind CHECK (trigger_kind IN ('delay_once', 'cron')),
    CONSTRAINT ck_scheduled_tasks_target_kind  CHECK (target_kind IN ('session_wakeup', 'job_dispatch')),
    CONSTRAINT ck_scheduled_tasks_status CHECK (
        status IN ('scheduled', 'firing', 'missed', 'expired', 'cancelled', 'completed')),
    CONSTRAINT ck_scheduled_tasks_cron_expr CHECK (
        (trigger_kind = 'cron' AND cron_expr IS NOT NULL) OR
        (trigger_kind = 'delay_once' AND cron_expr IS NULL)),
    CONSTRAINT ck_scheduled_tasks_expires_at CHECK (
        (trigger_kind = 'delay_once' AND expires_at IS NOT NULL) OR
        (trigger_kind = 'cron' AND expires_at IS NULL)),
    CONSTRAINT ck_scheduled_tasks_session_target CHECK (
        (target_kind = 'session_wakeup') OR
        (target_kind = 'job_dispatch' AND target_session_id IS NULL AND prompt IS NULL)),
    CONSTRAINT ck_scheduled_tasks_prompt CHECK (
        (target_kind = 'session_wakeup' AND prompt IS NOT NULL) OR
        (target_kind = 'job_dispatch' AND payload IS NOT NULL))
);

-- due 扫描主索引：只扫活跃行
CREATE INDEX idx_scheduled_tasks_due
    ON scheduled_tasks (next_fire_at)
    WHERE status = 'scheduled';

-- 列表页按 workspace 倒序
CREATE INDEX idx_scheduled_tasks_workspace_created_at
    ON scheduled_tasks (workspace_id, created_at DESC);

-- 0486 #9: per-principal quota count (workspace total cap 50 stays service-side)
CREATE INDEX idx_scheduled_tasks_user_status
    ON scheduled_tasks (user_id, status)
    WHERE status IN ('scheduled', 'firing', 'missed');
