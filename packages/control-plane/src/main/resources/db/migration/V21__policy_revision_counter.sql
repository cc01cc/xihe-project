-- =============================================================================
-- V21 — PLAN-0328 T1.7 fix：持久化策略修订改为单调计数器
-- =============================================================================
-- 动机：V20 用 policy_rules/tool_faces 的 max(updated_at) 作为 policy_revision，
--   删除非最新行（收紧性删除，如移除遮蔽 builtin ASK 的旧 workspace ALLOW）不改变
--   max，session 指纹/一次性 grant 不会被失效。改为单行单调计数器：
--   policy_revision(id=1, seq, updated_at)，每次规则/工具面变更（含删除）原子 +1；
--   approval_requests.policy_revision 记录计数器值，消费时段不平等即拒绝（fail-closed）。
--
-- 语义变更：旧行记录的 epoch 微秒与计数器值不再相等，切换后旧 grant 一律消费失败
--   （收紧方向，符合 fail-closed；不需要数据回填）。
-- 缺行语义：计数器行缺失时读取返回"不可用"哨兵并拒绝旧 grant；变更操作 fail-closed
--   中止（见 PolicyRevision）。
-- 兼容：TIMESTAMP WITH TIME ZONE / SMALLINT / BIGINT / CHECK / CURRENT_TIMESTAMP
--   在 PostgreSQL 与 H2(PostgreSQL 模式) 下均可用。
--
-- 回滚：DROP TABLE policy_revision;
-- =============================================================================

CREATE TABLE IF NOT EXISTS policy_revision (
    id         SMALLINT                 NOT NULL,
    seq        BIGINT                   NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL,
    CONSTRAINT pk_policy_revision PRIMARY KEY (id),
    CONSTRAINT ck_policy_revision_single_row CHECK (id = 1)
);

INSERT INTO policy_revision (id, seq, updated_at)
SELECT 1, 0, CURRENT_TIMESTAMP
WHERE NOT EXISTS (SELECT 1 FROM policy_revision WHERE id = 1);
