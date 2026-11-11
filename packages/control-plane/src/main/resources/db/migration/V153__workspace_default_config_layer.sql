-- D-928 / PLAN-0766 M2 (task-159): the shared WORKSPACE_DEFAULT config layer.
--
-- Layer semantics: workspace-default rows are deployment-wide defaults (owner = the instance,
-- i.e. user_id/workspace_id stay NULL) that apply to every workspace without an explicit value.
-- Database precedence: workspace > workspace-default > user > instance; env overlays and
-- administrator lock pins still outrank every database layer (unchanged).
--
-- Number allocation (checks at implementation time, 2026-11-11): develop tree max = V152
-- (V151/V152 from task-152 follow-ups); V153 absent from develop history and every worktree.
--
-- Atom seeds: MANAGE_WORKSPACE_DEFAULT_CONFIG (task-158 contract) is granted by default to
-- SUPER_ADMIN (parity mandate) and ADMIN (instance-administrator fixed set, D-931). The catalog
-- side lives in ToolFaceRegistry/PermissionAtomCatalog/SystemAccessRoleCatalog and must change in
-- the same batch or DefaultSetMigrationParityTest goes red.

-- Storage: widen the layer column first (V1 sized it 16; 'workspace-default' is 17), then widen
-- the layer CHECK with the fourth layer and bind its scope columns (both NULL, same shape as the
-- instance layer).
ALTER TABLE config ALTER COLUMN layer TYPE VARCHAR(24);
-- config_audit mirrors the layer value on every change record; same widening.
ALTER TABLE config_audit ALTER COLUMN layer TYPE VARCHAR(24);
ALTER TABLE config DROP CONSTRAINT IF EXISTS ck_config_layer;
ALTER TABLE config ADD CONSTRAINT ck_config_layer
    CHECK (layer IN ('instance', 'workspace', 'workspace-default', 'user'));
ALTER TABLE config DROP CONSTRAINT IF EXISTS ck_config_scope_binding;
ALTER TABLE config ADD CONSTRAINT ck_config_scope_binding CHECK (
    (layer = 'instance' AND user_id IS NULL AND workspace_id IS NULL)
    OR (layer = 'workspace-default' AND user_id IS NULL AND workspace_id IS NULL)
    OR (layer = 'user' AND user_id IS NOT NULL AND workspace_id IS NULL)
    OR (layer = 'workspace' AND workspace_id IS NOT NULL AND user_id IS NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_config_workspace_default_scope
    ON config (domain, config_key) WHERE layer = 'workspace-default';

-- Default grant set (D-931): SUPER_ADMIN + ADMIN only.
INSERT INTO role_permissions (role_id, action_class, resource_pattern) VALUES
    ('00000000-0000-4000-8000-000000000001', 'MANAGE_WORKSPACE_DEFAULT_CONFIG', '*'),
    ('00000000-0000-4000-8000-000000000002', 'MANAGE_WORKSPACE_DEFAULT_CONFIG', '*')
ON CONFLICT (role_id, action_class, resource_pattern) DO NOTHING;
