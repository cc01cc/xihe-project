-- PLAN-0651 ⑥ (D-174, user ruling 2026-11-05): the agent default instance role becomes
-- AGENT_USER (= human USER minus the agent-principal-forbidden CREATE_OWN_AGENT).
--
-- Stack-1 measured facts (Lead, read-only, xihe_1):
--   * role_permissions(USER) = read/write/delete/exec/network + CREATE_OWN_AGENT, resource '*';
--   * agent seed bindings to switch: subject_type='agent_principal' AND is_seed=true AND
--     role=USER AND scope_type='instance'  →  40 rows;
--   * other seeded agent bindings (AGENT_SPAWNER instance 1, AGENT_DELEGATOR workspace 1) are NOT
--     touched; human USER rows are NOT touched.
--
-- Scope/granted_by/is_seed survive the rebind (UPDATE, not delete+insert). Grants: the materialized
-- `source='role'` rows are re-derived for exactly the switched subjects — CREATE_OWN_AGENT rows go
-- (no other role carries it), AGENT_USER's five atoms replace them, every other atom is untouched.
-- Idempotent: guarded by NOT EXISTS / action-exists predicates.
--
-- Number: designed as V127 (main max was V126 at design time). Re-run the three checks at merge
-- time and rename if taken. Reversible: the UPDATE is symmetric (role_id back to USER), grants
-- re-derive from role_permissions.

-- 1. The role definition + its five atoms (ON CONFLICT ⇒ re-run inserts zero rows).
INSERT INTO roles (id, name, display_name, description, is_system)
VALUES ('00000000-0000-4000-8000-000000000008', 'AGENT_USER', 'Agent User (default)',
        'PLAN-0651 D-174: default instance role for agent principals — the human USER '
        || 'registration set minus the agent-forbidden CREATE_OWN_AGENT.', TRUE)
ON CONFLICT (id) DO NOTHING;

INSERT INTO role_permissions (role_id, action_class, resource_pattern) VALUES
    ('00000000-0000-4000-8000-000000000008', 'read', '*'),
    ('00000000-0000-4000-8000-000000000008', 'write', '*'),
    ('00000000-0000-4000-8000-000000000008', 'delete', '*'),
    ('00000000-0000-4000-8000-000000000008', 'exec', '*'),
    ('00000000-0000-4000-8000-000000000008', 'network', '*')
ON CONFLICT (role_id, action_class, resource_pattern) DO NOTHING;

-- 2. Rebind the legacy agent seed rows in place (scope/granted_by/is_seed preserved; unique keys
--    cannot collide because (subject_type, subject_id, scope_type, scope_id, role_id) changes only
--    in role_id and the AGENT_USER row does not exist for these subjects — guarded anyway).
UPDATE role_bindings rb
SET role_id = '00000000-0000-4000-8000-000000000008'
WHERE rb.role_id = '00000000-0000-4000-8000-000000000003'
  AND rb.subject_type = 'agent_principal'
  AND rb.is_seed = TRUE
  AND rb.scope_type = 'instance'
  AND NOT EXISTS (
      SELECT 1 FROM role_bindings other
      WHERE other.subject_type = rb.subject_type
        AND other.subject_id = rb.subject_id
        AND other.scope_type = rb.scope_type
        AND other.scope_id IS NOT DISTINCT FROM rb.scope_id
        AND other.role_id = '00000000-0000-4000-8000-000000000008');

-- 3. Re-derive `source='role'` grants for the switched subjects: drop the forbidden atom rows the
--    USER role used to materialize, then materialize AGENT_USER's atoms for any subject still
--    missing them (the runtime materializer uses the same derived shape).
DELETE FROM grants g
WHERE g.subject_type = 'agent_principal'
  AND g.source = 'role'
  AND g.scope_type = 'instance'
  AND g.scope_id IS NULL
  AND g.permissions @> '[{"actionClass": "CREATE_OWN_AGENT"}]'::jsonb
  AND NOT EXISTS (
      SELECT 1 FROM role_bindings rb
      JOIN roles r ON r.id = rb.role_id
      JOIN role_permissions rp ON rp.role_id = r.id
      WHERE rb.subject_type = 'agent_principal'
        AND rb.subject_id = g.subject_id
        AND lower(rp.action_class) = 'create_own_agent');

INSERT INTO grants (id, granter_type, granter_id, subject_type, subject_id, permissions, source,
                    scope_type, scope_id, read_state)
SELECT DISTINCT ON (rb.subject_id, rp.action_class)
       gen_random_uuid(), 'user', rb.subject_id, 'agent_principal', rb.subject_id,
       jsonb_build_array(jsonb_build_object('actionClass', rp.action_class)),
       'role', 'instance', NULL, 'read'
FROM role_bindings rb
JOIN role_permissions rp ON rp.role_id = rb.role_id
WHERE rb.role_id = '00000000-0000-4000-8000-000000000008'
  AND rb.subject_type = 'agent_principal'
  AND NOT EXISTS (
      SELECT 1 FROM grants g
      WHERE g.subject_type = 'agent_principal'
        AND g.subject_id = rb.subject_id
        AND g.source = 'role'
        AND g.scope_type = 'instance'
        AND g.scope_id IS NULL
        AND g.permissions @> jsonb_build_array(
            jsonb_build_object('actionClass', rp.action_class)))
ORDER BY rb.subject_id, rp.action_class;
