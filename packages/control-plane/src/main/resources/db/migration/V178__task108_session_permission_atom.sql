-- V178 (task-108 / D-1908 rev3): the session permission-tier relaxation atom.
--
-- Scope of this migration: the AUTHORIZATION face only ("who may change a session's tier"). The tier
-- column itself, the derivation of approval_mode and the strictest-wins evaluation chain belong to
-- task-107 (V176); this atom never decides WHICH value is allowed, only whether the actor may widen a
-- session that is already theirs to change.
--
-- The rule this atom encodes (D-1908 rev3 §3): tightening a session's tier is always free — any
-- participant may narrow the session they are in, no atom needed. Widening (relaxing) it requires
-- BOTH the atom AND the session's creator: sessions.user_id == the acting user. There is no OWNER
-- participant role to lean on (session_participants roles are PRIMARY/MEMBER/GUARD, V92:66), so the
-- creator check is an explicit column predicate, not a role lookup.
--
-- Number allocation (checks at implementation time, 2026-11-20): develop tree max = V176 (V177 is
-- reserved for task-106's workspace_agents.is_default and merges first); the lead fixed V178 for this
-- card. Installments follow mounting order; the registry row lives in one/docs/migration-numbers.md.
--
-- Default grant set: WS_OWNER + WS_EDITOR + ADMIN, mirroring V157's reasoning (owner/editor administer
-- the workspace, ADMIN keeps parity with the fixed instance-administrator set so the change is not a
-- capability SHRINK for administrators). WS_VIEWER stays out: a read-only member cannot widen a
-- session's write surface. SUPER_ADMIN holds every action atom by definition (superAdminAtoms()),
-- and DefaultSetMigrationParityTest requires its row here.
-- Whether WS_EDITOR should really be able to relax OTHER PEOPLE's sessions is a semantic question the
-- card leaves with the lead (V157 "give first, ask later"); the endpoint still pins the actor to the
-- session's creator, so the editor atom only ever applies to sessions the editor created.

-- ---------------------------------------------------------------------------------------------
-- 1) Role seeds (4 rows). Form copied from V157:35-44.
-- ---------------------------------------------------------------------------------------------
INSERT INTO role_permissions (role_id, action_class, resource_pattern) VALUES
    ('00000000-0000-4000-8000-000000000001', 'session:permission:configure', '*'),  -- SUPER_ADMIN
    ('00000000-0000-4000-8000-000000000002', 'session:permission:configure', '*'),  -- ADMIN
    ('00000000-0000-4000-8000-000000000004', 'session:permission:configure', '*'),  -- WS_OWNER
    ('00000000-0000-4000-8000-000000000005', 'session:permission:configure', '*')   -- WS_EDITOR
ON CONFLICT (role_id, action_class, resource_pattern) DO NOTHING;

-- ---------------------------------------------------------------------------------------------
-- 2) Grantees that already exist (same shape as V157:46-88): a new role seed alone does not
--    materialize grants for members bound before this migration, so existing WS_OWNER / WS_EDITOR /
--    ADMIN bindings would be refused until something re-materialized them. Scope comes from the
--    binding (the ck_role_bindings_scope constraint guarantees instance ⇒ NULL, workspace ⇒ id);
--    DISTINCT ON collapses a subject holding two of the four roles in the same scope.
-- ---------------------------------------------------------------------------------------------
INSERT INTO grants (id, granter_type, granter_id, subject_type, subject_id, permissions, source,
                    scope_type, scope_id, read_state)
SELECT DISTINCT ON (b.subject_type, b.subject_id, b.scope_type, b.scope_id, rp.action_class)
       gen_random_uuid(),
       CASE WHEN b.granted_by IS NULL THEN NULL ELSE 'user' END,
       b.granted_by,
       b.subject_type, b.subject_id,
       jsonb_build_array(jsonb_build_object('actionClass', rp.action_class)),
       'role', b.scope_type, b.scope_id, 'read'
FROM role_bindings b
JOIN role_permissions rp ON rp.role_id = b.role_id
WHERE rp.action_class = 'session:permission:configure'
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
