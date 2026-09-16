-- =============================================================================
-- V24 — PLAN-0337 T1.4：Session 审批模式落库
-- =============================================================================
-- 目的：Session 模式此前只存在于 CP 内存（SessionPolicyState），CP 重启后丢失，
--   与「重启后保留」的用户预期不符。本迁移把模式持久化到 sessions 行：
--   approval_mode：NULL = 继承 workspace 的 approval-policy.mode；'manual' / 'auto' = 会话覆盖。
--
-- 只落模式：会话级规则（session rules）与复用 grant 仍随会话内存生命周期，不落库。
-- 校验：CHECK 只允许 manual/auto/NULL，非法值在写入端点即被拒绝，不依赖数据库兜底。
-- 旧值兼容：列可空，既有行自动为 NULL（继承 workspace 默认），无数据回填。
--
-- 回滚：ALTER TABLE sessions DROP CONSTRAINT ck_sessions_approval_mode;
--       ALTER TABLE sessions DROP COLUMN approval_mode;
-- =============================================================================

ALTER TABLE sessions
    ADD COLUMN approval_mode VARCHAR(16);

ALTER TABLE sessions
    ADD CONSTRAINT ck_sessions_approval_mode
        CHECK (approval_mode IS NULL OR approval_mode IN ('manual', 'auto'));

COMMENT ON COLUMN sessions.approval_mode IS
    'PLAN-0337: session-scoped approval mode; NULL inherits approval-policy.mode from the workspace';
