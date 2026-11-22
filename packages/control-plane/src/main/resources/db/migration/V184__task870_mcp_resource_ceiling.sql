-- task-870 / D-1921: the `mcp:*` gateway-resource ceiling.
--
-- Criterion: an external MCP tool call carries the object resource(s) parsed from its arguments
-- AND `mcp:<serverId>`. A principal must hold every (actionClass × resource) pair. This migration
-- is only the projection of `SystemGrantPresetCatalog.mcpCeilingAtoms()`; the code catalog stays the
-- single source of truth and `DefaultSetMigrationParityTest` fails on any drift.
--
-- Default grant surface (user ruling, no compatibility layer):
--   * SUPER_ADMIN — every gateway action (mirror of superAdminAtoms());
--   * ADMIN       — read/write/delete/exec/network/PLUGIN_INVOKE (mirror of USER_DEFAULT_ATOMS);
--   * WS_OWNER    — read/write/delete/exec/PLUGIN_INVOKE (WS_OWNER holds no `network`);
-- every other preset, including every agent preset, stays without the wildcard. An agent may use a
-- gateway server only through an explicit `mcp:<serverId>` grant. Consequence, recorded in the
-- release note: after upgrade an un-granted agent is refused by every external MCP server
-- (fail-closed), while built-in tools (`__system__`/`__cp__`) are unaffected because they have no
-- catalog row and therefore never receive an `mcp:` pair.

-- ---------------------------------------------------------------------------------------------
-- 1) Preset-atom seeds (17 rows). Form copied from V183 (post-V182 table names).
-- ---------------------------------------------------------------------------------------------
INSERT INTO grant_preset_atoms (role_id, action_class, resource_pattern) VALUES
    -- SUPER_ADMIN
    ('00000000-0000-4000-8000-000000000001', 'action:read', 'mcp:*'),
    ('00000000-0000-4000-8000-000000000001', 'action:write', 'mcp:*'),
    ('00000000-0000-4000-8000-000000000001', 'action:delete', 'mcp:*'),
    ('00000000-0000-4000-8000-000000000001', 'action:exec', 'mcp:*'),
    ('00000000-0000-4000-8000-000000000001', 'action:network', 'mcp:*'),
    ('00000000-0000-4000-8000-000000000001', 'action:PLUGIN_INVOKE', 'mcp:*'),
    -- ADMIN
    ('00000000-0000-4000-8000-000000000002', 'action:read', 'mcp:*'),
    ('00000000-0000-4000-8000-000000000002', 'action:write', 'mcp:*'),
    ('00000000-0000-4000-8000-000000000002', 'action:delete', 'mcp:*'),
    ('00000000-0000-4000-8000-000000000002', 'action:exec', 'mcp:*'),
    ('00000000-0000-4000-8000-000000000002', 'action:network', 'mcp:*'),
    ('00000000-0000-4000-8000-000000000002', 'action:PLUGIN_INVOKE', 'mcp:*'),
    -- WS_OWNER (no network)
    ('00000000-0000-4000-8000-000000000004', 'action:read', 'mcp:*'),
    ('00000000-0000-4000-8000-000000000004', 'action:write', 'mcp:*'),
    ('00000000-0000-4000-8000-000000000004', 'action:delete', 'mcp:*'),
    ('00000000-0000-4000-8000-000000000004', 'action:exec', 'mcp:*'),
    ('00000000-0000-4000-8000-000000000004', 'action:PLUGIN_INVOKE', 'mcp:*')
ON CONFLICT (role_id, action_class, resource_pattern) DO NOTHING;

-- ---------------------------------------------------------------------------------------------
-- 2) Grantees bound before this migration. A preset-atom row alone does not materialize grants,
--    so existing SUPER_ADMIN/ADMIN/WS_OWNER bindings would lose gateway access until something
--    re-materializes them. Shape copied from V183 (post-V182 names).
-- ---------------------------------------------------------------------------------------------
INSERT INTO grants (id, granter_type, granter_id, subject_type, subject_id, permissions, source,
                    scope_type, scope_id, read_state)
SELECT DISTINCT ON (b.subject_type, b.subject_id, b.scope_type, b.scope_id, rp.action_class)
       gen_random_uuid(),
       CASE WHEN b.granted_by IS NULL THEN NULL ELSE 'user' END,
       b.granted_by,
       b.subject_type, b.subject_id,
       jsonb_build_array(jsonb_build_object('actionClass', rp.action_class,
                                            'resource', rp.resource_pattern)),
       'preset', b.scope_type, b.scope_id, 'read'
FROM grant_preset_bindings b
JOIN grant_preset_atoms rp ON rp.role_id = b.role_id
WHERE rp.resource_pattern = 'mcp:*'
  AND b.role_id IN ('00000000-0000-4000-8000-000000000001',  -- SUPER_ADMIN
                    '00000000-0000-4000-8000-000000000002',  -- ADMIN
                    '00000000-0000-4000-8000-000000000004')  -- WS_OWNER
  AND NOT EXISTS (
      SELECT 1 FROM grants g
      WHERE g.subject_type = b.subject_type
        AND g.subject_id = b.subject_id
        AND g.source = 'preset'
        AND g.scope_type = b.scope_type
        AND g.scope_id IS NOT DISTINCT FROM b.scope_id
        AND g.permissions->0->>'actionClass' = rp.action_class
        AND g.permissions->0->>'resource' = rp.resource_pattern);
