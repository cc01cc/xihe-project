-- =============================================================================
-- V16 — PLAN-0328 M1 复审修复：审批决策种类 + 待决查询索引
-- =============================================================================
-- decision_kind：终局行记录决策种类（once/session/saved/reject/reject_always；
--   传播路径记 propagated_allow/propagated_reject），使终局行的幂等重放按"决策种类"
--   判等，而不是仅比较布尔 approved。旧行保持 NULL，继续走 approved 比较（fail-closed）。
-- idx_approval_requests_user_workspace_state：pendingSummaries 按
--   (user, workspace, state, expires_at) 过滤，原表只有 session 前缀索引，缺该前缀。
--
-- 回滚：DROP INDEX idx_approval_requests_user_workspace_state; ALTER TABLE
--   approval_requests DROP COLUMN decision_kind;
-- =============================================================================

ALTER TABLE approval_requests
    ADD COLUMN decision_kind VARCHAR(32);

CREATE INDEX IF NOT EXISTS idx_approval_requests_user_workspace_state
    ON approval_requests (user_id, workspace_id, state, created_at);
