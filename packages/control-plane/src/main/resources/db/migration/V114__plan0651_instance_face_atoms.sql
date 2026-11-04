-- PLAN-0651 M2 T2.2 (batch 1 of 3) — instance-face atoms: N2/N3/N4.
--
-- Lead allocation: this migration owns the number range V114..V119 (as-landed order, no gaps).
-- Batch 1 seeds the three instance-domain atoms and backfills the instance-scope grant rows.
--
-- Atoms (spec/atom-contract.md §3, scope_class = instance):
--   N2 READ_INSTANCE_CONTENT   — read instance-layer config and instance templates
--   N3 WRITE_INSTANCE_CONTENT  — write instance-layer config / templates / API request templates
--   N4 VIEW_SECRET_CONTENT     — see unmasked credential values (a masking decision, never a 403)
--
-- Default grant set: SUPER_ADMIN and ADMIN only (fixed instance-administrator set, D51-27).
-- WS_* roles never receive them: the atoms are instance-bindable only, so a workspace binding is
-- rejected at write time with 400 ROLE_SCOPE_MISMATCH (decision #12/#27).
--
-- Idempotency: role_permissions uses ON CONFLICT (role_id, action_class, resource_pattern) DO
-- NOTHING; the grant backfill uses NOT EXISTS, so running the statements twice leaves every count
-- unchanged (there is no unique constraint to lean on for grants, hence NOT EXISTS).
--
-- Validation queries (also asserted by the migration tests):
--   -- rows present after this migration (expected 6 = 3 atoms x 2 roles)
--   SELECT count(*) FROM role_permissions
--   WHERE action_class IN ('READ_INSTANCE_CONTENT','WRITE_INSTANCE_CONTENT','VIEW_SECRET_CONTENT')
--     AND role_id IN ('00000000-0000-4000-8000-000000000001',
--                     '00000000-0000-4000-8000-000000000002');
--   -- every instance-tier holder of an admin role got the three materialized rows (expected 0)
--   SELECT count(*) FROM role_bindings b
--   WHERE b.subject_type = 'user' AND b.scope_type = 'instance'
--     AND b.role_id IN ('00000000-0000-4000-8000-000000000001',
--                       '00000000-0000-4000-8000-000000000002')
--     AND EXISTS (SELECT 1 FROM (VALUES ('READ_INSTANCE_CONTENT'),
--                                      ('WRITE_INSTANCE_CONTENT'),
--                                      ('VIEW_SECRET_CONTENT')) AS a(atom)
--                 WHERE NOT EXISTS (SELECT 1 FROM grants g
--                                   WHERE g.subject_type = 'user' AND g.subject_id = b.subject_id
--                                     AND g.source = 'role' AND g.scope_type = 'instance'
--                                     AND g.scope_id IS NULL
--                                     AND g.permissions->0->>'actionClass' = a.atom));

-- 1. Role definitions: the three instance-face atoms join SUPER_ADMIN and ADMIN.
INSERT INTO role_permissions (role_id, action_class, resource_pattern) VALUES
    ('00000000-0000-4000-8000-000000000001', 'READ_INSTANCE_CONTENT', '*'),
    ('00000000-0000-4000-8000-000000000001', 'WRITE_INSTANCE_CONTENT', '*'),
    ('00000000-0000-4000-8000-000000000001', 'VIEW_SECRET_CONTENT', '*'),
    ('00000000-0000-4000-8000-000000000002', 'READ_INSTANCE_CONTENT', '*'),
    ('00000000-0000-4000-8000-000000000002', 'WRITE_INSTANCE_CONTENT', '*'),
    ('00000000-0000-4000-8000-000000000002', 'VIEW_SECRET_CONTENT', '*')
ON CONFLICT (role_id, action_class, resource_pattern) DO NOTHING;

-- 2. Instance-scope grant backfill, one statement per atom (mirrors V111's per-atom shape so a
--    partially-applied environment can be re-run safely).
INSERT INTO grants (id, granter_type, granter_id, subject_type, subject_id, permissions, source,
                    scope_type, scope_id, read_state)
SELECT DISTINCT ON (b.subject_id)
       gen_random_uuid(), 'user', b.subject_id, 'user', b.subject_id,
       jsonb_build_array(jsonb_build_object('actionClass', 'READ_INSTANCE_CONTENT')),
       'role', 'instance', NULL, 'read'
FROM role_bindings b
WHERE b.subject_type = 'user'
  AND b.scope_type = 'instance'
  AND b.role_id IN ('00000000-0000-4000-8000-000000000001',
                    '00000000-0000-4000-8000-000000000002')
  AND NOT EXISTS (
      SELECT 1 FROM grants g
      WHERE g.subject_type = 'user'
        AND g.subject_id = b.subject_id
        AND g.source = 'role'
        AND g.scope_type = 'instance'
        AND g.scope_id IS NULL
        AND g.permissions->0->>'actionClass' = 'READ_INSTANCE_CONTENT');

INSERT INTO grants (id, granter_type, granter_id, subject_type, subject_id, permissions, source,
                    scope_type, scope_id, read_state)
SELECT DISTINCT ON (b.subject_id)
       gen_random_uuid(), 'user', b.subject_id, 'user', b.subject_id,
       jsonb_build_array(jsonb_build_object('actionClass', 'WRITE_INSTANCE_CONTENT')),
       'role', 'instance', NULL, 'read'
FROM role_bindings b
WHERE b.subject_type = 'user'
  AND b.scope_type = 'instance'
  AND b.role_id IN ('00000000-0000-4000-8000-000000000001',
                    '00000000-0000-4000-8000-000000000002')
  AND NOT EXISTS (
      SELECT 1 FROM grants g
      WHERE g.subject_type = 'user'
        AND g.subject_id = b.subject_id
        AND g.source = 'role'
        AND g.scope_type = 'instance'
        AND g.scope_id IS NULL
        AND g.permissions->0->>'actionClass' = 'WRITE_INSTANCE_CONTENT');

INSERT INTO grants (id, granter_type, granter_id, subject_type, subject_id, permissions, source,
                    scope_type, scope_id, read_state)
SELECT DISTINCT ON (b.subject_id)
       gen_random_uuid(), 'user', b.subject_id, 'user', b.subject_id,
       jsonb_build_array(jsonb_build_object('actionClass', 'VIEW_SECRET_CONTENT')),
       'role', 'instance', NULL, 'read'
FROM role_bindings b
WHERE b.subject_type = 'user'
  AND b.scope_type = 'instance'
  AND b.role_id IN ('00000000-0000-4000-8000-000000000001',
                    '00000000-0000-4000-8000-000000000002')
  AND NOT EXISTS (
      SELECT 1 FROM grants g
      WHERE g.subject_type = 'user'
        AND g.subject_id = b.subject_id
        AND g.source = 'role'
        AND g.scope_type = 'instance'
        AND g.scope_id IS NULL
        AND g.permissions->0->>'actionClass' = 'VIEW_SECRET_CONTENT');

-- No default policy rules: the retired PolicyVerdict lets unknown domains default to allow, so the
-- absence of rules keeps administrators working (asserted by P0ManagementAtomSeedMigrationTest).
