-- =============================================================================
-- V15 — PLAN-0328 M1：策略规则表 + 工具面注册表（持久层）
-- =============================================================================
-- 目的：把"审批规则"与"工具分类"从代码内置扩展为可按层持久配置：
--   policy_rules：{layer, owner, actionClass, resource, effect, priority, locked}
--   tool_faces  ：{scope, owner, tool, actionClass, shape}
--
-- 与 config 三层的关系：**不使用 config 表**（PLAN-0307 已钉死 8 域集合，新增域会
--   冲突）；本表自带 layer/owner，语义与 config 的 instance/user/workspace 一致。
--
-- 回滚：两表为新增，可直接 DROP；无数据迁移。
-- =============================================================================

CREATE TABLE IF NOT EXISTS policy_rules (
    id           UUID         NOT NULL,
    layer        VARCHAR(16)  NOT NULL,
    owner_id     VARCHAR(36),
    action_class VARCHAR(64)  NOT NULL,
    resource     VARCHAR(512) NOT NULL,
    effect       VARCHAR(8)   NOT NULL,
    priority     INTEGER      NOT NULL,
    locked       BOOLEAN      NOT NULL,
    created_by   VARCHAR(36)  NOT NULL,
    created_at   TIMESTAMPTZ  NOT NULL,
    updated_at   TIMESTAMPTZ  NOT NULL,
    CONSTRAINT pk_policy_rules PRIMARY KEY (id),
    CONSTRAINT ck_policy_rules_layer  CHECK (layer IN ('instance', 'user', 'workspace')),
    CONSTRAINT ck_policy_rules_effect CHECK (effect IN ('allow', 'ask', 'deny')),
    -- locked 规则只允许收紧（deny/ask），永不 allow（决策 #39）
    CONSTRAINT ck_policy_rules_locked CHECK ((NOT locked) OR effect IN ('ask', 'deny')),
    CONSTRAINT ck_policy_rules_owner  CHECK (
        (layer = 'instance' AND owner_id IS NULL)
        OR (layer <> 'instance' AND owner_id IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_policy_rules_scope
    ON policy_rules (layer, COALESCE(owner_id, '-'), action_class, resource);

CREATE INDEX IF NOT EXISTS ix_policy_rules_scope_lookup
    ON policy_rules (layer, owner_id);

CREATE TABLE IF NOT EXISTS tool_faces (
    id           UUID         NOT NULL,
    scope        VARCHAR(16)  NOT NULL,
    owner_id     VARCHAR(36),
    tool         VARCHAR(128) NOT NULL,
    action_class VARCHAR(64)  NOT NULL,
    shape        VARCHAR(16)  NOT NULL,
    created_by   VARCHAR(36)  NOT NULL,
    created_at   TIMESTAMPTZ  NOT NULL,
    updated_at   TIMESTAMPTZ  NOT NULL,
    CONSTRAINT pk_tool_faces PRIMARY KEY (id),
    CONSTRAINT ck_tool_faces_scope CHECK (scope IN ('instance', 'workspace')),
    CONSTRAINT ck_tool_faces_shape CHECK (shape IN ('structured', 'interpreter', 'opaque')),
    CONSTRAINT ck_tool_faces_owner CHECK (
        (scope = 'instance' AND owner_id IS NULL)
        OR (scope <> 'instance' AND owner_id IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_tool_faces_scope
    ON tool_faces (scope, COALESCE(owner_id, '-'), tool);

CREATE INDEX IF NOT EXISTS ix_tool_faces_scope_lookup
    ON tool_faces (scope, owner_id);
