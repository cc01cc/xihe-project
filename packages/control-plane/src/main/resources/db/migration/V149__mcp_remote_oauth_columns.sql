-- PLAN-0759 / BL-548: server-level OAuth client configuration for remote MCP servers.
-- Column names and types mirror the McpServer entity annotations exactly; the H2
-- test lane builds its schema from JPA (Flyway disabled), so a mismatch here would
-- make production and test schemas diverge silently.
-- All columns are nullable: rows created before this migration stay valid as plain
-- http endpoints (no backfill, per D-215).
ALTER TABLE mcp_remote_servers ADD COLUMN oauth_client_id VARCHAR(255);
ALTER TABLE mcp_remote_servers ADD COLUMN oauth_authorization_endpoint VARCHAR(512);
ALTER TABLE mcp_remote_servers ADD COLUMN oauth_token_endpoint VARCHAR(512);
ALTER TABLE mcp_remote_servers ADD COLUMN oauth_redirect_uri VARCHAR(512);
ALTER TABLE mcp_remote_servers ADD COLUMN oauth_scope VARCHAR(1024);
