-- PLAN-0622 M0.3 (D8): the sixteenth action atom, CREATE_OWN_AGENT.
--
-- D8 ruling (user 2026-11-02, `spec/security/principal-workspace-scope.md` §3 + PLAN-0622
-- design §9): an ordinary account may create its own PERSONAL agent principal, so the atom joins
-- the USER default set (and therefore ADMIN/SUPER_ADMIN, which are supersets). It is deliberately
-- ONE atom: the workspace tier still needs MANAGE_WORKSPACE_AGENTS and the instance tier still
-- needs CREATE_ACCOUNT — the three creation actions stay independent and are never alias-merged.
--
-- Two statements, both required:
--   1. the role definitions gain the atom (catalog side; the code-side catalog derives
--      SUPER_ADMIN from PermissionAtomCatalog.actionAtoms(), this keeps the PostgreSQL seed equal);
--   2. every already-materialized instance-scope tier subject gets the matching
--      source='role' row, because evaluation reads the materialized rows — without this backfill
--      existing accounts would keep the old five-atom set until their next materialization
--      (registration of a new user, a role edit, or an owner hand-over), which would make the
--      new capability appear only for new accounts.
--
-- * Reversible: DELETE the three role_permissions rows and the source='role' rows whose
--   permissions[0].actionClass = 'CREATE_OWN_AGENT'.

INSERT INTO role_permissions (role_id, action_class, resource_pattern) VALUES
    ('00000000-0000-4000-8000-000000000001', 'CREATE_OWN_AGENT', '*'),
    ('00000000-0000-4000-8000-000000000002', 'CREATE_OWN_AGENT', '*'),
    ('00000000-0000-4000-8000-000000000003', 'CREATE_OWN_AGENT', '*')
ON CONFLICT (role_id, action_class, resource_pattern) DO NOTHING;

-- Backfill the materialized atom for every user subject holding one of the three instance tier
-- roles. One row per atom (V87 uq_grants_role_atom): the NOT EXISTS guard keeps the statement
-- idempotent and the jsonb shape identical to RoleGrantMaterializer#atomArray (wildcard resource is
-- omitted). DISTINCT ON (subject_id) because a subject may hold more than one tier binding (for
-- example USER and ADMIN); without it the second binding violates uq_grants_role_atom.
INSERT INTO grants (id, granter_type, granter_id, subject_type, subject_id, permissions, source,
                    scope_type, scope_id, read_state)
SELECT DISTINCT ON (b.subject_id)
       gen_random_uuid(), 'user', b.subject_id, 'user', b.subject_id,
       jsonb_build_array(jsonb_build_object('actionClass', 'CREATE_OWN_AGENT')),
       'role', 'instance', NULL, 'read'
FROM role_bindings b
WHERE b.subject_type = 'user'
  AND b.scope_type = 'instance'
  AND b.role_id IN ('00000000-0000-4000-8000-000000000001',
                    '00000000-0000-4000-8000-000000000002',
                    '00000000-0000-4000-8000-000000000003')
  AND NOT EXISTS (
      SELECT 1 FROM grants g
      WHERE g.subject_type = 'user'
        AND g.subject_id = b.subject_id
        AND g.source = 'role'
        AND g.scope_type = 'instance'
        AND g.scope_id IS NULL
        AND g.permissions -> 0 ->> 'actionClass' = 'CREATE_OWN_AGENT')
ORDER BY b.subject_id;
