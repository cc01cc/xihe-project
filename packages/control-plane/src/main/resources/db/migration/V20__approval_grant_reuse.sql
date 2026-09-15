-- =============================================================================
-- V20 — PLAN-0328 T1.7：审批 grant 复用（session 指纹 + 版本/世代失效）
-- =============================================================================
-- 目的：把一次批准绑定的复用边界持久化，供消费校验（fail-closed）：
--   policy_revision   ：决策时策略版本（policy_rules/tool_faces 的 max(updated_at)，epoch 微秒；
--                       空表 = 0）。消费时不一致 → 拒绝（规则/分类已变，旧批准不可复用）。
--   sandbox_generation：决策时 workspace.generation（执行规范世代）。消费时不一致 → 拒绝。
--   reuse_scope       ：本行授予的复用档（once|session|saved）；旧行 NULL 按 once 处理，
--                       已拒绝的行留 NULL（不可消费）。
--
-- idx_approval_requests_reuse_lookup：闸门按 (session_id, tool, arguments_hash) 查找同
--   会话同调用的非终态行，避免为同一次调用重复建档（幂等；arguments_hash 可为 NULL，
--   该索引仅服务含 hash 的精确匹配）。
--
-- 回滚：DROP INDEX idx_approval_requests_reuse_lookup;
--       ALTER TABLE approval_requests DROP COLUMN reuse_scope / sandbox_generation /
--         policy_revision（约束随列删除而失效，必要时显式 DROP CONSTRAINT）。
-- =============================================================================

ALTER TABLE approval_requests
    ADD COLUMN policy_revision BIGINT;

ALTER TABLE approval_requests
    ADD COLUMN sandbox_generation INTEGER;

ALTER TABLE approval_requests
    ADD COLUMN reuse_scope VARCHAR(16);

ALTER TABLE approval_requests
    ADD CONSTRAINT ck_approval_requests_reuse_scope
        CHECK (reuse_scope IS NULL OR reuse_scope IN ('once', 'session', 'saved'));

CREATE INDEX IF NOT EXISTS idx_approval_requests_reuse_lookup
    ON approval_requests (session_id, tool, arguments_hash);
