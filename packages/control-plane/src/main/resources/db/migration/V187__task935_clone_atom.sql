-- task-935 / D-1935: the `action:clone` atom. Agent presets carry it by default; human presets
-- do not. The code catalog (SystemGrantPresetCatalog) is the authority; this file is its
-- projection, and DefaultSetMigrationParityTest fails on any drift.

INSERT INTO grant_preset_atoms (role_id, action_class, resource_pattern) VALUES
    ('00000000-0000-4000-8000-000000000007', 'action:clone', '*'),  -- AGENT_DELEGATOR
    ('00000000-0000-4000-8000-000000000008', 'action:clone', '*'),  -- AGENT_USER
    ('00000000-0000-4000-8000-000000000009', 'action:clone', '*'),  -- AGENT_READER
    ('00000000-0000-4000-8000-000000000010', 'action:clone', '*'),  -- AGENT_WORKER
    ('00000000-0000-4000-8000-000000000001', 'action:clone', '*')   -- SUPER_ADMIN mirror
ON CONFLICT (role_id, action_class, resource_pattern) DO NOTHING;

-- Bindings materialized before this migration: a preset-atom row alone does not rewrite their
-- grants, so clone holders would otherwise wait for a re-materialization. Shape follows V183/V184.
INSERT INTO grants (id, granter_type, granter_id, subject_type, subject_id, permissions, source,
                    scope_type, scope_id, read_state)
SELECT DISTINCT ON (b.subject_type, b.subject_id, b.scope_type, b.scope_id)
       gen_random_uuid(),
       CASE WHEN b.granted_by IS NULL THEN NULL ELSE 'user' END,
       b.granted_by,
       b.subject_type, b.subject_id,
       jsonb_build_array(jsonb_build_object('actionClass', 'action:clone', 'resource', '*')),
       'assigned', b.scope_type, b.scope_id, 'read'
FROM grant_preset_bindings b
JOIN grant_preset_atoms rp ON rp.role_id = b.role_id
WHERE rp.action_class = 'action:clone'
  AND b.role_id IN ('00000000-0000-4000-8000-000000000001',
                    '00000000-0000-4000-8000-000000000007',
                    '00000000-0000-4000-8000-000000000008',
                    '00000000-0000-4000-8000-000000000009',
                    '00000000-0000-4000-8000-000000000010')
  AND NOT EXISTS (
      SELECT 1 FROM grants g
      WHERE g.subject_type = b.subject_type
        AND g.subject_id = b.subject_id
        AND g.scope_type = b.scope_type
        AND g.scope_id IS NOT DISTINCT FROM b.scope_id
        AND g.permissions->0->>'actionClass' = 'action:clone');
