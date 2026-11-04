-- PLAN-0651 M2 T2.2 (batch 2 of 3) — workspace-face atoms: N5/N6/N7/N8/N9.
--
-- Number range V114..V119 (Lead allocation, as-landed order). Batch 1 = V114 (instance face).
--
-- Atoms (spec/atom-contract.md §3, scope_class = both):
--   N5 MANAGE_SKILL_LIBRARY          — skill-library definitions + skill bindings
--   N6 MANAGE_PROVIDER_CONNECTIONS   — provider connection create/update/delete (workspace range)
--   N7 USE_WORKSPACE_RUNTIME         — read the environment snapshot / trigger a runtime release
--   N8 MANAGE_WORKSPACE_RUNTIME      — switch the execution mode (owner semantics)
--   N9 MANAGE_WORKSPACE_POLICY       — workspace-layer policy rules / tool face
--
-- Default grant set (spec §3 table; code side is SystemAccessRoleCatalog):
--   SUPER_ADMIN + ADMIN  : all five, at instance scope (everywhere)
--   WS_OWNER             : all five, at workspace scope
--   WS_EDITOR            : N6, N7, N9
--   WS_VIEWER            : N7
--   WS_OWNER/EDITOR/VIEWER never get N10 (member administration, ruling D51-26).
--
-- Idempotency: role_permissions uses ON CONFLICT (role_id, action_class, resource_pattern) DO
-- NOTHING. Both backfills derive the atom from role_permissions, so the rows a subject receives are
-- exactly the atoms its role defines — never a blanket grant — and NOT EXISTS makes a re-run insert
-- zero rows (asserted by the migration tests).
--
-- Workspace backfill dedupe: a subject may hold several bindings of the same role in one workspace,
-- so the statement filters with DISTINCT ON (subject_id, scope_id): one row per (subject, workspace,
-- atom), never two.

-- 1. Role definitions (19 rows).
INSERT INTO role_permissions (role_id, action_class, resource_pattern) VALUES
    ('00000000-0000-4000-8000-000000000001', 'MANAGE_SKILL_LIBRARY', '*'),
    ('00000000-0000-4000-8000-000000000001', 'MANAGE_PROVIDER_CONNECTIONS', '*'),
    ('00000000-0000-4000-8000-000000000001', 'USE_WORKSPACE_RUNTIME', '*'),
    ('00000000-0000-4000-8000-000000000001', 'MANAGE_WORKSPACE_RUNTIME', '*'),
    ('00000000-0000-4000-8000-000000000001', 'MANAGE_WORKSPACE_POLICY', '*'),
    ('00000000-0000-4000-8000-000000000002', 'MANAGE_SKILL_LIBRARY', '*'),
    ('00000000-0000-4000-8000-000000000002', 'MANAGE_PROVIDER_CONNECTIONS', '*'),
    ('00000000-0000-4000-8000-000000000002', 'USE_WORKSPACE_RUNTIME', '*'),
    ('00000000-0000-4000-8000-000000000002', 'MANAGE_WORKSPACE_RUNTIME', '*'),
    ('00000000-0000-4000-8000-000000000002', 'MANAGE_WORKSPACE_POLICY', '*'),
    ('00000000-0000-4000-8000-000000000004', 'MANAGE_SKILL_LIBRARY', '*'),
    ('00000000-0000-4000-8000-000000000004', 'MANAGE_PROVIDER_CONNECTIONS', '*'),
    ('00000000-0000-4000-8000-000000000004', 'USE_WORKSPACE_RUNTIME', '*'),
    ('00000000-0000-4000-8000-000000000004', 'MANAGE_WORKSPACE_RUNTIME', '*'),
    ('00000000-0000-4000-8000-000000000004', 'MANAGE_WORKSPACE_POLICY', '*'),
    ('00000000-0000-4000-8000-000000000005', 'MANAGE_PROVIDER_CONNECTIONS', '*'),
    ('00000000-0000-4000-8000-000000000005', 'USE_WORKSPACE_RUNTIME', '*'),
    ('00000000-0000-4000-8000-000000000005', 'MANAGE_WORKSPACE_POLICY', '*'),
    ('00000000-0000-4000-8000-000000000006', 'USE_WORKSPACE_RUNTIME', '*')
ON CONFLICT (role_id, action_class, resource_pattern) DO NOTHING;

-- 2a. Instance-scope backfill for the two administrator roles (one row per subject, per atom).
INSERT INTO grants (id, granter_type, granter_id, subject_type, subject_id, permissions, source,
                    scope_type, scope_id, read_state)
SELECT DISTINCT ON (b.subject_id, rp.action_class)
       gen_random_uuid(), 'user', b.subject_id, 'user', b.subject_id,
       jsonb_build_array(jsonb_build_object('actionClass', rp.action_class)),
       'role', 'instance', NULL, 'read'
FROM role_bindings b
JOIN role_permissions rp ON rp.role_id = b.role_id
WHERE b.subject_type = 'user'
  AND b.scope_type = 'instance'
  AND b.role_id IN ('00000000-0000-4000-8000-000000000001',
                    '00000000-0000-4000-8000-000000000002')
  AND rp.action_class IN ('MANAGE_SKILL_LIBRARY', 'MANAGE_PROVIDER_CONNECTIONS',
                          'USE_WORKSPACE_RUNTIME', 'MANAGE_WORKSPACE_RUNTIME',
                          'MANAGE_WORKSPACE_POLICY')
  AND NOT EXISTS (
      SELECT 1 FROM grants g
      WHERE g.subject_type = 'user'
        AND g.subject_id = b.subject_id
        AND g.source = 'role'
        AND g.scope_type = 'instance'
        AND g.scope_id IS NULL
        AND g.permissions->0->>'actionClass' = rp.action_class);

-- 2b. Workspace-scope backfill for the three workspace roles. The atom comes from the role's own
--     permission rows, so WS_EDITOR receives only N6/N7/N9 and WS_VIEWER only N7.
INSERT INTO grants (id, granter_type, granter_id, subject_type, subject_id, permissions, source,
                    scope_type, scope_id, read_state)
SELECT DISTINCT ON (b.subject_id, b.scope_id, rp.action_class)
       gen_random_uuid(), 'user', b.subject_id, 'user', b.subject_id,
       jsonb_build_array(jsonb_build_object('actionClass', rp.action_class)),
       'role', 'workspace', b.scope_id, 'read'
FROM role_bindings b
JOIN role_permissions rp ON rp.role_id = b.role_id
WHERE b.subject_type = 'user'
  AND b.scope_type = 'workspace'
  AND b.scope_id IS NOT NULL
  AND b.role_id IN ('00000000-0000-4000-8000-000000000004',
                    '00000000-0000-4000-8000-000000000005',
                    '00000000-0000-4000-8000-000000000006')
  AND rp.action_class IN ('MANAGE_SKILL_LIBRARY', 'MANAGE_PROVIDER_CONNECTIONS',
                          'USE_WORKSPACE_RUNTIME', 'MANAGE_WORKSPACE_RUNTIME',
                          'MANAGE_WORKSPACE_POLICY')
  AND NOT EXISTS (
      SELECT 1 FROM grants g
      WHERE g.subject_type = 'user'
        AND g.subject_id = b.subject_id
        AND g.source = 'role'
        AND g.scope_type = 'workspace'
        AND g.scope_id = b.scope_id
        AND g.permissions->0->>'actionClass' = rp.action_class);

-- No new default policy rules (see V111/V114 rationale).
