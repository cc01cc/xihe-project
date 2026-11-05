-- BL-345 (user ruling 2026-11-06): "users can write their own agent memory".
--
-- Two atoms, two scopes of meaning:
--   * MEMORY_WRITE      = write ANY subject  → SUPER_ADMIN (already seeded by V99) + workspace
--                         administrators (WS_OWNER), per ruling B.
--   * MEMORY_WRITE_SELF = write a principal the actor OWNS (agent_principals.owner_user_id /
--                         created_by_user_id) → default for USER, ADMIN and every WS_* role, so an
--                         ordinary account no longer needs a MEMORY_WRITE grant for its own agent.
--
-- The atom is AGENT_FORBIDDEN: an agent principal may never hold MEMORY_WRITE_SELF (it is a human
-- ownership capability). AGENT_USER's five atoms are unchanged, so no agent binding is touched.
--
-- Number allocation (three checks at design time, 2026-11-06): main checkout max V128; this
-- worktree max V128; V129 free. Idempotent: uq (role_id, action_class, resource_pattern) on
-- role_permissions and the grants NOT EXISTS guard both make a re-run insert zero rows.
--
-- Reversible: delete the five role_permissions rows below and the source='role' grant rows whose
-- permissions contain MEMORY_WRITE_SELF (audit_logs is not rewritten).

-- 1. Role definitions: SELF for the human USER/ADMIN/WS_* roles; MEMORY_WRITE only for WS_OWNER.
INSERT INTO role_permissions (role_id, action_class, resource_pattern) VALUES
    ('00000000-0000-4000-8000-000000000001', 'MEMORY_WRITE_SELF', '*'),
    ('00000000-0000-4000-8000-000000000003', 'MEMORY_WRITE_SELF', '*'),
    ('00000000-0000-4000-8000-000000000002', 'MEMORY_WRITE_SELF', '*'),
    ('00000000-0000-4000-8000-000000000004', 'MEMORY_WRITE_SELF', '*'),
    ('00000000-0000-4000-8000-000000000005', 'MEMORY_WRITE_SELF', '*'),
    ('00000000-0000-4000-8000-000000000006', 'MEMORY_WRITE_SELF', '*'),
    ('00000000-0000-4000-8000-000000000004', 'MEMORY_WRITE', '*')
ON CONFLICT (role_id, action_class, resource_pattern) DO NOTHING;

-- 2. Backfill the materialized `source='role'` grants for existing bindings, so granted subjects get
--    exactly the atoms their role now defines (one row per subject/atom/scope). Guarded by NOT
--    EXISTS so a re-run inserts nothing.
--
--    Upgrade-path dedupe (BL-366, 2026-11-06): NOT EXISTS only sees rows committed before this
--    statement, so it cannot de-duplicate rows produced by this same INSERT … SELECT. A subject can
--    hold more than one tier binding (e.g. instance USER + ADMIN) that both declare these atoms, and
--    uq_grants_role_atom is an EXPRESSION index on
--    (subject_type, subject_id, scope_type, scope_id, actionClass, COALESCE(resource,'*'))
--    ⇒ the second row raises 23505 and the whole upgrade aborts (fresh DBs never see it because
--    role_bindings is empty there). V91:38-42 documented the same pitfall for its own backfill.
--    ON CONFLICT DO NOTHING (no target) is used instead of DISTINCT ON: with an expression index the
--    conflict arbiter would have to repeat the index expression (easy to get wrong); the untargeted
--    form lets PostgreSQL use uq_grants_role_atom directly.
INSERT INTO grants (id, granter_type, granter_id, subject_type, subject_id, permissions, source,
                    scope_type, scope_id, read_state)
SELECT gen_random_uuid(), 'user', b.subject_id, b.subject_type, b.subject_id,
       jsonb_build_array(jsonb_build_object('actionClass', rp.action_class)),
       'role', b.scope_type, b.scope_id, 'read'
FROM role_bindings b
JOIN role_permissions rp ON rp.role_id = b.role_id
WHERE rp.action_class IN ('MEMORY_WRITE_SELF', 'MEMORY_WRITE')
  AND NOT EXISTS (
      SELECT 1 FROM grants g
      WHERE g.subject_type = b.subject_type
        AND g.subject_id = b.subject_id
        AND g.source = 'role'
        AND g.scope_type = b.scope_type
        AND g.scope_id IS NOT DISTINCT FROM b.scope_id
        AND g.permissions @> jsonb_build_array(jsonb_build_object('actionClass', rp.action_class)))
ON CONFLICT DO NOTHING;
