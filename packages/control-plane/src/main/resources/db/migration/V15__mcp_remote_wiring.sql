-- PLAN-242 M2：remote 接线
-- 1) mcp_servers 加 auth_mode（oauth/no-auth，默认 oauth；no-auth 免 broker，见 M1.3 实测）
-- 2) mcp_tool_aliases 存 sticky 命名映射（workspace_id + issued_name 主键，永不晋升，见 §6#4）

ALTER TABLE mcp_servers ADD COLUMN auth_mode VARCHAR(16) NOT NULL DEFAULT 'oauth';

CREATE TABLE mcp_tool_aliases (
    workspace_id VARCHAR(36)  NOT NULL REFERENCES workspaces(id),
    issued_name  VARCHAR(255) NOT NULL,
    server_id    VARCHAR(36)  NOT NULL,
    backend_name VARCHAR(255) NOT NULL,
    generation   BIGINT       NOT NULL DEFAULT 0,
    created_at   TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at   TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT pk_mcp_tool_aliases PRIMARY KEY (workspace_id, issued_name)
);

CREATE INDEX idx_mcp_tool_aliases_server ON mcp_tool_aliases(workspace_id, server_id);
