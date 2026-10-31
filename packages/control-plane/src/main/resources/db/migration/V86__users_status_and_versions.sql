-- V86 — PLAN-0581 用户管理面：账号状态 / 软删 / refresh epoch。
--
-- 冻结稿：plans/PLAN-0581-XH-user-management/spec/migration-v86.md §2（逐字落地）。
-- 前置：V85__instance_ownership.sql 已合入（PLAN-0580；本迁移的 revokeSessions 需 bump
--       users.token_version，且 Flyway 默认 outOfOrder=false 要求版本单调）。
-- 回滚：ALTER TABLE users DROP COLUMN status, DROP COLUMN deleted_at, DROP COLUMN session_version;
--       注意回滚会丢撤销能力（已停用账号的 refresh token 重新可用）——正式回滚口径见冻结稿 §5。

ALTER TABLE users
    ADD COLUMN status          VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
    ADD COLUMN deleted_at      TIMESTAMPTZ,
    ADD COLUMN session_version INTEGER     NOT NULL DEFAULT 0;

ALTER TABLE users ADD CONSTRAINT ck_users_status CHECK (status IN ('ACTIVE', 'DISABLED'));
ALTER TABLE users ADD CONSTRAINT ck_users_deleted_status CHECK (deleted_at IS NULL OR status = 'DISABLED');

COMMENT ON COLUMN users.status IS
    'PLAN-0581: ACTIVE|DISABLED (ck_users_status). Non-ACTIVE users cannot log in or refresh.';
COMMENT ON COLUMN users.deleted_at IS
    'PLAN-0581: soft-delete marker; non-null implies status=DISABLED (ck_users_deleted_status). v1 is irreversible.';
COMMENT ON COLUMN users.session_version IS
    'PLAN-0581: refresh-token epoch carried as the `sv` claim; bumped with token_version on disable/soft-delete/password-reset.';
