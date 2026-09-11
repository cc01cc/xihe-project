-- PLAN-301 M2 (decision #1): per-server tool execution timeout.
-- NULL = inherit the global default (XIHE_MCP_TOOL_TIMEOUT_S on the Agent
-- side). The Agent reads this value from the MCP initialization payload the
-- CP forwards; callers may still override per-call via toolTimeoutOverrides.
ALTER TABLE mcp_servers ADD COLUMN tool_timeout_s INTEGER;
ALTER TABLE mcp_servers ADD CONSTRAINT ck_mcp_servers_tool_timeout
    CHECK (tool_timeout_s IS NULL OR tool_timeout_s > 0);
