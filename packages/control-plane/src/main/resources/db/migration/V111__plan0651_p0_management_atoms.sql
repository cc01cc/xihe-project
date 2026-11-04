-- PLAN-0651 M1 (D51-26/D51-27): the P0 management atoms — MANAGE_AGENT_PRINCIPALS and
-- MANAGE_WORKSPACE_MEMBERS — plus `workspace:admin` for the built-in ADMIN role.
--
-- Why this migration exists
--   * Today the instance-administrator bypass on two faces is a role-name-shaped code decision
--     (`CapabilityAuthorities`): the agent-principal face
--     (AgentPrincipalService:1053/1122) and the workspace-member face (WorkspaceMemberService:166).
--     PLAN-0651 moves both to action atoms so the answer becomes a grant ("why is this subject in
--     the list?") instead of a code branch.
--   * `workspace:admin` is seeded into ADMIN at instance scope: A9 (`AuthzContext:133-136`, the
--     instance-administrator OR workspace-admin check) is retired, so "instance admin administers
--     every workspace" must come from the default grant set, not from code (D51-11). The atom
--     itself is a capability atom and therefore never materialized into `grants` (PLAN-0610
--     decision #23).
--   * MANAGE_WORKSPACE_MEMBERS is deliberately NOT seeded into WS_OWNER: the instance-admin-only
--     "emergency member removal" must not leak to every holder of MANAGE_WORKSPACE_AGENTS, and
--     giving it to WS_OWNER would also hand member add/remove to workspace owners, which is a
--     product decision (D51-26). A8 (session participants) stays on MANAGE_WORKSPACE_AGENTS
--     (D51-29), so this migration does NOT seed MANAGE_WORKSPACE_AGENTS into ADMIN (14-1: that
--     would turn `RequesterAuthority.requireWorkspaceBindingAuthority` from 403 into allow).
--
-- Two statement groups, both required (V91 template):
--   1. the role definitions gain the atoms (PostgreSQL side; the code-side mirror is
--      SystemAccessRoleCatalog.roleSeeds(), asserted by
--      AgentPrincipalScopeMigrationTest#headSeedsMatchTheCodeSideCatalog);
--   2. every already-materialized instance-scope subject bound to those roles gets the matching
--      `source='role'` rows. Evaluation reads the materialized rows, so without the backfill the
--      new atoms would only appear after the subject's next materialization (a role edit, a new
--      registration, an owner hand-over) — a lock-out window.
--
-- * Reversible: DELETE the five role_permissions rows added below, and the source='role' rows whose
--   permissions[0].actionClass is one of the two new atoms.
-- * Idempotent: ON CONFLICT (role_id, action_class, resource_pattern) DO NOTHING + NOT EXISTS.
-- * Zero-gap assertion (run by P0ManagementAtomSeedMigrationTest, not only documented here):
--     SELECT count(*) FROM role_bindings b
--     JOIN role_permissions rp ON rp.role_id = b.role_id
--     WHERE rp.action_class IN ('MANAGE_AGENT_PRINCIPALS','MANAGE_WORKSPACE_MEMBERS')
--       AND NOT EXISTS (SELECT 1 FROM grants g
--                       WHERE g.subject_type='user' AND g.subject_id=b.subject_id
--                         AND g.source='role' AND g.scope_type=b.scope_type
--                         AND coalesce(g.scope_id,'00000000-0000-0000-0000-000000000000'::uuid)
--                           = coalesce(b.scope_id,'00000000-0000-0000-0000-000000000000'::uuid)
--                         AND g.permissions->0->>'actionClass' = rp.action_class);
--   expected 0.
--
-- * Zero-gap check for D51-30 (PLAN-0651 T1.2): the migration does NOT add `workspace:admin` to
--   custom roles, so a custom role carrying `instance:admin` alone stops implying workspace
--   administration (A9 no longer ORs in the instance-administrator flag). Detect any holder that
--   would be affected — DO NOT rewrite data automatically, report the count and stop:
--     SELECT count(*) FROM role_bindings b
--     JOIN roles r ON r.id = b.role_id AND r.is_system = FALSE
--     WHERE EXISTS (SELECT 1 FROM role_permissions rp
--                   WHERE rp.role_id = r.id AND rp.action_class = 'instance:admin')
--       AND NOT EXISTS (SELECT 1 FROM role_permissions rp2
--                       WHERE rp2.role_id = r.id AND rp2.action_class = 'workspace:admin');
--   expected 0 (XH not released); asserted by P0ManagementAtomSeedMigrationTest.
--
-- * No default policy rule is seeded for the new atoms: with rule adjudication retired
--   (PolicyVerdict: "rule adjudication retired"), an empty policy_rules set means the default
--   verdict is allow — a seeded deny would silently lock administrators out once someone writes
--   a rule. Asserted by P0ManagementAtomSeedMigrationTest.

-- 1a. SUPER_ADMIN: every action atom is seeded, so the two new atoms join its definition.
INSERT INTO role_permissions (role_id, action_class, resource_pattern) VALUES
    ('00000000-0000-4000-8000-000000000001', 'MANAGE_AGENT_PRINCIPALS', '*'),
    ('00000000-0000-4000-8000-000000000001', 'MANAGE_WORKSPACE_MEMBERS', '*')
ON CONFLICT (role_id, action_class, resource_pattern) DO NOTHING;

-- 1b. ADMIN: the two management atoms + workspace:admin (A9 default-set semantics).
INSERT INTO role_permissions (role_id, action_class, resource_pattern) VALUES
    ('00000000-0000-4000-8000-000000000002', 'MANAGE_AGENT_PRINCIPALS', '*'),
    ('00000000-0000-4000-8000-000000000002', 'MANAGE_WORKSPACE_MEMBERS', '*'),
    ('00000000-0000-4000-8000-000000000002', 'workspace:admin', '*')
ON CONFLICT (role_id, action_class, resource_pattern) DO NOTHING;

-- 2a. Backfill MANAGE_AGENT_PRINCIPALS for every instance-scope subject holding SUPER_ADMIN/ADMIN.
--     DISTINCT ON (b.subject_id): a subject may hold more than one tier binding, and
--     uq_grants_role_atom allows one row per (subject, atom) — without it the second binding
--     violates the index and the whole migration fails (same failure V91 documents).
INSERT INTO grants (id, granter_type, granter_id, subject_type, subject_id, permissions, source,
                    scope_type, scope_id, read_state)
SELECT DISTINCT ON (b.subject_id)
       gen_random_uuid(), 'user', b.subject_id, 'user', b.subject_id,
       jsonb_build_array(jsonb_build_object('actionClass', 'MANAGE_AGENT_PRINCIPALS')),
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
        AND g.permissions -> 0 ->> 'actionClass' = 'MANAGE_AGENT_PRINCIPALS')
ORDER BY b.subject_id;

-- 2b. Backfill MANAGE_WORKSPACE_MEMBERS, same scope and same guard.
INSERT INTO grants (id, granter_type, granter_id, subject_type, subject_id, permissions, source,
                    scope_type, scope_id, read_state)
SELECT DISTINCT ON (b.subject_id)
       gen_random_uuid(), 'user', b.subject_id, 'user', b.subject_id,
       jsonb_build_array(jsonb_build_object('actionClass', 'MANAGE_WORKSPACE_MEMBERS')),
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
        AND g.permissions -> 0 ->> 'actionClass' = 'MANAGE_WORKSPACE_MEMBERS')
ORDER BY b.subject_id;
