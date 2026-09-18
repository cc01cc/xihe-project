-- PLAN-0351 M1 (DDL-9/10, decision #8 ruling 2026-09-19): drop dead columns.
-- Liveness (evidence/queries-dead-columns.md): none of the five columns has a
-- code or runtime consumer (getter/setter call sites, DTO/OpenAPI/UI/Agent
-- surfaces). Fresh-path policy (decision #11): no data is carried, local
-- databases are rebuilt from V1; rollback = clean rebuild (spec §1).
-- DDL-10: the TEXT-vs-JSONB divergence disappears with these columns; new
-- JSON columns must be JSONB. messages.attachments and
-- operation_items.policy_summary stay TEXT by explicit exception (live
-- consumers, out of the DDL-10 scope).

ALTER TABLE workspaces DROP COLUMN settings;
ALTER TABLE workspaces DROP COLUMN storage_path;
ALTER TABLE users DROP COLUMN settings;
ALTER TABLE messages DROP COLUMN metadata;
ALTER TABLE mcp_remote_servers DROP COLUMN auth_config;
