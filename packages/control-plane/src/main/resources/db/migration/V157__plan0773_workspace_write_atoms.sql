-- V157 (PLAN-0773 / task-229): the two workspace write faces get atoms (H1 / H2 / H3).
--
-- The holes this closes (measured before the change, all three answered to isAuthenticated() plus
-- "can reach the workspace" only, i.e. ANY member including WS_VIEWER could rewrite them):
--   H1  PUT /api/v1/config/workspace/{domain}              -> WRITE_WORKSPACE_CONTENT
--   H2  PUT /api/v1/workspaces/{workspaceId}/mcp-config    -> MANAGE_WORKSPACE_MCP
--   H3  PUT /api/v1/workspaces/{workspaceId}/stdio-servers -> MANAGE_WORKSPACE_MCP
-- H2/H3 share ONE atom on purpose: they write the same mcp_server_catalog rows, and two atoms would
-- let a role be allowed at the new door while refused at the legacy door.
--
-- Number allocation (checks at implementation time, 2026-11-12): develop tree max = V156
-- (V156__plan0772_personal_skill_scope.sql); `git log --all -- <dir>/V157* <dir>/V158*` = 0 hits;
-- `git worktree list` = this checkout only. => V157, not a guess.
--
-- Default grant set (the ruling this migration implements): WS_OWNER + WS_EDITOR yes, WS_VIEWER no
-- ("a read-only member cannot change the configuration" is the semantic being made real). ADMIN is
-- included as well, NOT as extra privilege but to avoid a capability SHRINK: the fixed
-- instance-administrator set already carries the sibling workspace-layer management atoms
-- (MANAGE_WORKSPACE_POLICY / MANAGE_WORKSPACE_RUNTIME / MANAGE_PROVIDER_CONNECTIONS /
-- MANAGE_SKILL_LIBRARY — SystemAccessRoleCatalog's ADMIN seed), so granting the two new faces to
-- everybody except ADMIN would take away the instance administrator's ability to write a
-- workspace's configuration and MCP servers. SUPER_ADMIN holds every action atom by definition
-- (superAdminAtoms() derives from PermissionAtomCatalog.actionAtoms()), so its rows are the mirror
-- mandate of DefaultSetMigrationParityTest (a code-side atom without its seed row leaves
-- SUPER_ADMIN one atom short and the parity test red — the same rule V153/V156 documented).
--
-- Atom catalog side (same batch, or DefaultSetMigrationParityTest goes red): ToolFaceRegistry's two
-- new constants, PermissionAtomCatalog ACTION_ATOM_NAMES, PermissionAtomLabels, SystemAccessRoleCatalog
-- ADMIN / WS_OWNER / WS_EDITOR seeds.

-- ---------------------------------------------------------------------------------------------
-- 1) Role seeds (8 rows). Form copied from V153:35-38 / V156:5 (the newest minimal seed pattern):
--    idempotent ON CONFLICT, so a re-run on an already-seeded database is a no-op.
-- ---------------------------------------------------------------------------------------------
INSERT INTO role_permissions (role_id, action_class, resource_pattern) VALUES
    ('00000000-0000-4000-8000-000000000001', 'WRITE_WORKSPACE_CONTENT', '*'),  -- SUPER_ADMIN
    ('00000000-0000-4000-8000-000000000002', 'WRITE_WORKSPACE_CONTENT', '*'),  -- ADMIN
    ('00000000-0000-4000-8000-000000000004', 'WRITE_WORKSPACE_CONTENT', '*'),  -- WS_OWNER
    ('00000000-0000-4000-8000-000000000005', 'WRITE_WORKSPACE_CONTENT', '*'),  -- WS_EDITOR
    ('00000000-0000-4000-8000-000000000001', 'MANAGE_WORKSPACE_MCP', '*'),    -- SUPER_ADMIN
    ('00000000-0000-4000-8000-000000000002', 'MANAGE_WORKSPACE_MCP', '*'),    -- ADMIN
    ('00000000-0000-4000-8000-000000000004', 'MANAGE_WORKSPACE_MCP', '*'),    -- WS_OWNER
    ('00000000-0000-4000-8000-000000000005', 'MANAGE_WORKSPACE_MCP', '*')     -- WS_EDITOR
ON CONFLICT (role_id, action_class, resource_pattern) DO NOTHING;

-- ---------------------------------------------------------------------------------------------
-- 2) Grantees that already exist: the seed rows above only shape the ROLES; a grant is materialized
--    per subject × scope (RoleGrantMaterializer). Without this backfill an existing WS_OWNER/WS_EDITOR
--    member would be refused by the new gate until something happened to re-materialize them, i.e.
--    the fix would only arrive for newly bound members. Same shape as V115:51-74 / V156:5b.
--
--    Scope is taken from the BINDING (b.scope_type/b.scope_id) rather than written literally: a
--    binding carries the constraint ck_role_bindings_scope (instance ⇒ NULL scope_id, workspace ⇒
--    NOT NULL), so the materialized row lands in exactly the scope the role was bound in — an
--    instance-tier SUPER_ADMIN/ADMIN grant stays instance-scope, a WS_* binding stays
--    workspace-scope with its workspace id. DISTINCT ON collapses the case where one subject holds
--    BOTH WS_OWNER and WS_EDITOR in the same workspace (two binding rows, one atom).
--    Both subject kinds participate: WS_* roles are bindable to agent principals (BL-349), and an
--    agent bound as an editor of a workspace may write that workspace's configuration — the new
--    atoms are deliberately NOT in AGENT_FORBIDDEN_ATOMS.
-- ---------------------------------------------------------------------------------------------
INSERT INTO grants (id, granter_type, granter_id, subject_type, subject_id, permissions, source,
                    scope_type, scope_id, read_state)
SELECT DISTINCT ON (b.subject_type, b.subject_id, b.scope_type, b.scope_id, rp.action_class)
       gen_random_uuid(),
       -- ck_grants_granter_ref: granter_type is NULL exactly when granter_id is. Use the binding's
       -- own grantor when it has one (whoever bound the role); an unattributed binding leaves both
       -- NULL rather than inventing a self-grant shaped like a human action.
       CASE WHEN b.granted_by IS NULL THEN NULL ELSE 'user' END,
       b.granted_by,
       b.subject_type, b.subject_id,
       jsonb_build_array(jsonb_build_object('actionClass', rp.action_class)),
       'role', b.scope_type, b.scope_id, 'read'
FROM role_bindings b
JOIN role_permissions rp ON rp.role_id = b.role_id
WHERE rp.action_class IN ('WRITE_WORKSPACE_CONTENT', 'MANAGE_WORKSPACE_MCP')
  AND b.role_id IN ('00000000-0000-4000-8000-000000000001',  -- SUPER_ADMIN
                    '00000000-0000-4000-8000-000000000002',  -- ADMIN
                    '00000000-0000-4000-8000-000000000004',  -- WS_OWNER
                    '00000000-0000-4000-8000-000000000005')  -- WS_EDITOR
  AND NOT EXISTS (
      SELECT 1 FROM grants g
      WHERE g.subject_type = b.subject_type
        AND g.subject_id = b.subject_id
        AND g.source = 'role'
        AND g.scope_type = b.scope_type
        AND g.scope_id IS NOT DISTINCT FROM b.scope_id
        AND g.permissions->0->>'actionClass' = rp.action_class);
