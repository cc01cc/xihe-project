-- task-832 / D-1129 follow-up: the authorization vocabulary is now 「授权预设 / grant preset」.
--
-- This migration renames the five persistence surfaces and converts the materialized source value
-- in place. It is deliberately one transaction: the tables, the rows and the CHECK constraint must
-- move together, otherwise a half-applied database either rejects the new rows (old CHECK) or
-- silently stops evaluating the materialized set (evaluation source closed list).
--
-- The old table names are not kept as views: this is a pre-MVP vocabulary change with no
-- compatibility layer (user ruling 2026-11-22).

ALTER TABLE roles RENAME TO grant_presets;
ALTER TABLE role_permissions RENAME TO grant_preset_atoms;
ALTER TABLE role_bindings RENAME TO grant_preset_bindings;
ALTER TABLE org_unit_role_bindings RENAME TO org_unit_preset_bindings;

-- V108 is a backfill script name, not a table name: no such table exists in the V1..V181 chain.
-- IF EXISTS keeps the rename idempotent for databases that once carried it out-of-tree.
ALTER TABLE IF EXISTS agent_principal_role_bindings RENAME TO agent_principal_preset_bindings;

-- grants.source: the materialized union of a subject's preset bindings.
-- Order matters: the UPDATE must be unreachable by the old CHECK, so drop it first, then convert,
-- then install the new closed set.
ALTER TABLE grants DROP CONSTRAINT ck_grants_source;
UPDATE grants SET source = 'preset' WHERE source = 'role';
ALTER TABLE grants ADD CONSTRAINT ck_grants_source
    CHECK (source IN ('preset', 'spawn', 'template', 'credential_binding', 'agent_default',
                      'plugin_binding'));
