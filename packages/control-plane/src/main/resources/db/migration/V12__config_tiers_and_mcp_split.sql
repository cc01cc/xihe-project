-- =============================================================================
-- V12 — PLAN-0307: config 三层化（instance/workspace/user）+ MCP 分载体
-- =============================================================================
-- 前置：迁移前必须 pg_dump 全库备份（Flyway 不负责备份）。
--
-- 顺序（不可调换）：断言 → MCP stdio 迁出 → 层值规范化 → 加标识列 → user 回填
--   → 对账 → 审计解耦 → 清理 system/workspace → 约束/索引 → 删列 → MCP remote 改名。
--
-- 回滚：结构可反 DDL（重加 environment/mcp_config/is_set、改回表名/约束名）；
--   **数据不可逆**——environment/mcp_config/is_set 列与 system/workspace 行删除后
--   只能从 pg_dump 备份恢复。
-- =============================================================================

-- ① 前置断言：层取值合法 + 归一化后 instance 层无重复键
DO $$
DECLARE bad_layer text; dup_inst int;
BEGIN
    SELECT string_agg(DISTINCT layer, ',') INTO bad_layer
      FROM config
     WHERE layer NOT IN ('admin', 'system', 'user', 'workspace');
    IF bad_layer IS NOT NULL THEN
        RAISE EXCEPTION 'V12 aborted: unexpected config.layer values: %', bad_layer;
    END IF;

    SELECT count(*) INTO dup_inst FROM (
        SELECT environment, domain, config_key
          FROM config WHERE layer = 'admin'
         GROUP BY 1, 2, 3 HAVING count(*) > 1
    ) t;
    IF dup_inst > 0 THEN
        RAISE EXCEPTION 'V12 aborted: % duplicate admin (domain,key) rows after environment removal', dup_inst;
    END IF;
END $$;

-- ② MCP stdio：新表 + envelope verbatim 迁出（外层结构化，内层保持 Claude Desktop 格式）
CREATE TABLE IF NOT EXISTS mcp_stdio_servers (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID         NOT NULL,
    name         VARCHAR(255) NOT NULL,
    config       JSONB        NOT NULL,
    enabled      BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    CONSTRAINT fk_mcp_stdio_servers_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE CASCADE,
    CONSTRAINT uq_mcp_stdio_servers_workspace_name UNIQUE (workspace_id, name),
    CONSTRAINT ck_mcp_stdio_servers_config CHECK (jsonb_typeof(config) = 'object')
);

CREATE INDEX IF NOT EXISTS idx_mcp_stdio_servers_workspace ON mcp_stdio_servers (workspace_id);

INSERT INTO mcp_stdio_servers (id, workspace_id, name, config)
SELECT gen_random_uuid(), (c.environment)::uuid, kv.key, kv.value
  FROM config c
 CROSS JOIN LATERAL jsonb_each(c.mcp_config -> 'mcpServers') AS kv(key, value)
 WHERE c.layer = 'workspace'
   AND c.domain = 'mcp'
   AND c.config_key = 'mcpServers'
   AND c.mcp_config IS NOT NULL
   AND jsonb_typeof(c.mcp_config -> 'mcpServers') = 'object'
ON CONFLICT (workspace_id, name) DO NOTHING;

-- ③ 层值规范化：admin → instance
UPDATE config SET layer = 'instance' WHERE layer = 'admin';

-- ④ 加标识列
ALTER TABLE config ADD COLUMN IF NOT EXISTS user_id UUID;
ALTER TABLE config ADD COLUMN IF NOT EXISTS workspace_id UUID;

-- ⑤ user 层回填（决策 #31：无 user 行跳过；有则绑最早用户；无用户可绑则中止）
DO $$
DECLARE user_rows int; target_user uuid;
BEGIN
    SELECT count(*) INTO user_rows FROM config WHERE layer = 'user';
    IF user_rows > 0 THEN
        SELECT id INTO target_user FROM users ORDER BY created_at ASC, id ASC LIMIT 1;
        IF target_user IS NULL THEN
            RAISE EXCEPTION 'V12 aborted: layer=user rows exist but no users available for binding';
        END IF;
        UPDATE config SET user_id = target_user WHERE layer = 'user' AND user_id IS NULL;
    END IF;
END $$;

-- ⑥ MCP 迁移对账（迁出行数不得少于 envelope 键数）
DO $$
DECLARE envelope_keys int; persisted int;
BEGIN
    SELECT coalesce(sum((SELECT count(*) FROM jsonb_object_keys(c.mcp_config -> 'mcpServers'))), 0)
      INTO envelope_keys
      FROM config c
     WHERE c.layer = 'workspace' AND c.domain = 'mcp' AND c.config_key = 'mcpServers'
       AND c.mcp_config IS NOT NULL AND jsonb_typeof(c.mcp_config -> 'mcpServers') = 'object';

    SELECT count(*) INTO persisted FROM mcp_stdio_servers;
    IF persisted < envelope_keys THEN
        RAISE EXCEPTION 'V12 aborted: mcp_stdio_servers=% < envelope keys=%', persisted, envelope_keys;
    END IF;
END $$;

-- ⑦ 审计解耦（决策 #30：审计行不因配置删除而丢失）后清理 system/workspace 行
--    config_id 原为 NOT NULL，SET NULL 前必须先解除列约束
ALTER TABLE config_audit ALTER COLUMN config_id DROP NOT NULL;
ALTER TABLE config_audit DROP CONSTRAINT IF EXISTS fk_config_audit_config;
ALTER TABLE config_audit
    ADD CONSTRAINT fk_config_audit_config FOREIGN KEY (config_id) REFERENCES config (id) ON DELETE SET NULL;
DELETE FROM config WHERE layer IN ('system', 'workspace');

-- ⑧ 约束与索引重构
ALTER TABLE config DROP CONSTRAINT IF EXISTS uq_config_scope;

ALTER TABLE config ADD CONSTRAINT ck_config_layer CHECK (layer IN ('instance', 'workspace', 'user'));
ALTER TABLE config ADD CONSTRAINT ck_config_scope_binding CHECK (
    (layer = 'instance' AND user_id IS NULL AND workspace_id IS NULL)
    OR (layer = 'user' AND user_id IS NOT NULL AND workspace_id IS NULL)
    OR (layer = 'workspace' AND workspace_id IS NOT NULL AND user_id IS NULL)
);
ALTER TABLE config ADD CONSTRAINT fk_config_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE;
ALTER TABLE config ADD CONSTRAINT fk_config_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE CASCADE;

CREATE UNIQUE INDEX IF NOT EXISTS uq_config_instance_scope ON config (domain, config_key) WHERE layer = 'instance';
CREATE UNIQUE INDEX IF NOT EXISTS uq_config_workspace_scope ON config (workspace_id, domain, config_key) WHERE layer = 'workspace';
CREATE UNIQUE INDEX IF NOT EXISTS uq_config_user_scope ON config (user_id, domain, config_key) WHERE layer = 'user';

-- ⑨ 删列（environment/mcp_config/is_set；created_at 已由 V8 补齐，idx_config_lookup 已由 V8 删除）
ALTER TABLE config DROP COLUMN IF EXISTS environment;
ALTER TABLE config DROP COLUMN IF EXISTS mcp_config;
ALTER TABLE config DROP COLUMN IF EXISTS is_set;

-- ⑩ MCP remote 改名 + 约束/索引名同步（PG 的 RENAME TABLE 不改约束/索引名）
ALTER TABLE mcp_servers RENAME TO mcp_remote_servers;
ALTER TABLE mcp_remote_servers RENAME CONSTRAINT mcp_servers_pkey TO mcp_remote_servers_pkey;
ALTER TABLE mcp_remote_servers RENAME CONSTRAINT fk_mcp_servers_workspace TO fk_mcp_remote_servers_workspace;
ALTER TABLE mcp_remote_servers RENAME CONSTRAINT ck_mcp_servers_auth_mode TO ck_mcp_remote_servers_auth_mode;
ALTER TABLE mcp_remote_servers RENAME CONSTRAINT ck_mcp_servers_tool_timeout TO ck_mcp_remote_servers_tool_timeout;
ALTER INDEX idx_mcp_servers_workspace_id RENAME TO idx_mcp_remote_servers_workspace_id;
-- 备注：oauth_credentials.server_id 的 FK 自动跟随表改名（约束名 fk_oauth_credentials_server 保留，已登记于 docs）
