-- PLAN-0673 M2 + M3 (D-166 / D-168, user rulings 2026-11-05) — the subset guard's two companions,
-- shipped in ONE migration so the gate and its widening land together (顺序门: 先护栏，后放宽).
--
--   * GRANT_ANY_ATOM (instance-only): the single bypass of the grant-side subset rule. Default
--     SUPER_ADMIN only — ADMIN must never hold it (that would defeat the whole guard).
--   * MANAGE_ROLES on ADMIN: ADMIN may now administer roles/bindings, but every grant still passes
--     GrantabilityGuard (403 PRIVILEGE_ESCALATION outside its own atom set).
--
-- Number allocation (three checks before taking V125, 2026-11-05): main max V124; every worktree max
-- V124; flyway_schema_history max 124 (118 success rows). V125 was free; no other lane reserved it.
--
-- Idempotency: role_permissions has uq (role_id, action_class, resource_pattern) ⇒ ON CONFLICT DO
-- NOTHING; the grants backfill joins role_permissions so it derives exactly the atoms the role now
-- defines, and NOT EXISTS makes a re-run insert zero rows.
--
-- Reversible: DELETE the two role_permissions rows and the source='role' instance-scope grants whose
-- only atom is GRANT_ANY_ATOM / MANAGE_ROLES (audit_logs is not rewritten).

-- 1. Role definitions: SUPER_ADMIN gets the bypass atom; ADMIN gets role administration.
INSERT INTO role_permissions (role_id, action_class, resource_pattern) VALUES
    ('00000000-0000-4000-8000-000000000001', 'GRANT_ANY_ATOM', '*'),
    ('00000000-0000-4000-8000-000000000002', 'MANAGE_ROLES', '*')
ON CONFLICT (role_id, action_class, resource_pattern) DO NOTHING;

-- 2. Backfill existing instance-scope bindings of those two roles so already-provisioned subjects
--    get exactly the atoms their role now defines (one row per subject/atom).
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
  AND rp.action_class IN ('GRANT_ANY_ATOM', 'MANAGE_ROLES')
  AND NOT EXISTS (
      SELECT 1 FROM grants g
      WHERE g.subject_type = 'user'
        AND g.subject_id = b.subject_id
        AND g.source = 'role'
        AND g.scope_type = 'instance'
        AND g.scope_id IS NULL
        AND g.permissions @> jsonb_build_array(
            jsonb_build_object('actionClass', rp.action_class)))
ORDER BY b.subject_id, rp.action_class;
