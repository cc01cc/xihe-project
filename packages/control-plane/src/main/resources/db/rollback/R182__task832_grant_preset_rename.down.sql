-- task-832: inverse of V182__task832_grant_preset_rename.sql.
--
-- Idempotent by construction: table renames use IF EXISTS, and the source conversion only touches
-- the value this migration introduced. A retried rollback is therefore safe.

ALTER TABLE grants DROP CONSTRAINT IF EXISTS ck_grants_source;
UPDATE grants SET source = 'role' WHERE source = 'preset';
ALTER TABLE grants ADD CONSTRAINT ck_grants_source
    CHECK (source IN ('role', 'spawn', 'template', 'credential_binding', 'agent_default',
                      'plugin_binding'));

ALTER TABLE IF EXISTS agent_principal_preset_bindings RENAME TO agent_principal_role_bindings;
ALTER TABLE IF EXISTS org_unit_preset_bindings RENAME TO org_unit_role_bindings;
ALTER TABLE IF EXISTS grant_preset_bindings RENAME TO role_bindings;
ALTER TABLE IF EXISTS grant_preset_atoms RENAME TO role_permissions;
ALTER TABLE IF EXISTS grant_presets RENAME TO roles;
