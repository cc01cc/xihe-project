-- PLAN-0414 T1.1/T1.3/T1.4: Context Template binding and immutable Run snapshot.
--
-- 存量处置（用户裁定 2026-10-03：「先清库，迁移里不该清」）：数据清理是迁移
-- 前置的运维动作（未上线开发库走 `mise run dev:reset`，V14 先例 dev-state
-- 可弃），本迁移**只做 schema**，不携带任何 DELETE/数据拦截——升级路径测试
-- 与历史回填语义必须能在完整迁移链上继续验证。
-- 万一存在未清理的存量行：三列均带 DEFAULT，旧行自动钉内置默认模板，
-- 属单条库默认值，不引入任何回填/兼容代码。

ALTER TABLE sessions
    ADD COLUMN context_template_layer VARCHAR(16) NOT NULL DEFAULT 'instance',
    ADD COLUMN context_template_id UUID NOT NULL DEFAULT '00000000-0000-4000-8000-000000000001',
    ADD COLUMN context_template_version INTEGER NOT NULL DEFAULT 1,
    ADD CONSTRAINT ck_sessions_context_template_layer
        CHECK (context_template_layer IN ('instance', 'user', 'workspace')),
    ADD CONSTRAINT ck_sessions_context_template_version
        CHECK (context_template_version > 0);

ALTER TABLE chat_runs
    ADD COLUMN context_template_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
    ADD CONSTRAINT ck_chat_runs_context_template_snapshot_object
        CHECK (jsonb_typeof(context_template_snapshot) = 'object');

COMMENT ON COLUMN sessions.context_template_layer IS
    'Explicit source layer for the immutable Context Template revision bound to this Session';
COMMENT ON COLUMN sessions.context_template_id IS
    'Stable Context Template UUID; revisions are append-only in the referenced config layer';
COMMENT ON COLUMN sessions.context_template_version IS
    'Immutable Context Template revision pinned for this Session';
COMMENT ON COLUMN chat_runs.context_template_snapshot IS
    'Atomic admission-time copy of the Session-bound Context Template revision; never changes in flight';
