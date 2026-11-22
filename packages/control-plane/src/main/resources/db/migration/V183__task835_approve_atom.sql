-- task-835 (approval contract §2.3): the approval-gate atom `action:approve`.
--
-- Criterion: `(action:approve, the resource of THIS approval request)` must both hit. The atom is
-- therefore never seeded with `*` — a wildcard approve grant would approve every resource at once.
-- Its canonical resource is the request-scoped sentinel `$request`
-- (ResourceNamespaces.REQUEST_RESOURCE): at evaluation it covers exactly the request's resource, and
-- the grant write face refuses both `*` and the sentinel from an API, so a stored approve grant
-- always names a concrete resource.
--
-- Default grant surface (code catalog is the authority; this file is only its projection):
--   * ADMIN     — instance administration includes deciding approvals;
--   * WS_OWNER  — a workspace owner decides approvals for this workspace;
--   * SUPER_ADMIN — mirror obligation (superAdminAtoms() holds every action atom;
--                   DefaultSetMigrationParityTest enforces the row).
-- Every other preset stays without it (least privilege).

-- ---------------------------------------------------------------------------------------------
-- 1) Preset-atom seeds (3 rows). Post-V182 table names; exact form of SystemGrantPresetCatalog.
-- ---------------------------------------------------------------------------------------------
INSERT INTO grant_preset_atoms (role_id, action_class, resource_pattern) VALUES
    ('00000000-0000-4000-8000-000000000001', 'action:approve', '$request'),  -- SUPER_ADMIN (mirror)
    ('00000000-0000-4000-8000-000000000002', 'action:approve', '$request'),  -- ADMIN
    ('00000000-0000-4000-8000-000000000004', 'action:approve', '$request')   -- WS_OWNER
ON CONFLICT (role_id, action_class, resource_pattern) DO NOTHING;

-- ---------------------------------------------------------------------------------------------
-- 2) Grantees that already exist: a preset-atom row alone does not materialize grants for subjects
--    bound before this migration. Shape copied from V178:46-88, adapted to the post-V182 names and
--    to the request-scoped resource (the JSON must carry it; omitting it would mean `*`).
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
WHERE rp.action_class = 'action:approve'
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
        AND g.permissions->0->>'actionClass' = rp.action_class);
