-- V156 (PLAN-0772 T2b.2 / task-221, D-1019 A2): the personal skill layer.
--
-- Storage shape (user ruling 2026-11-12, ledger D-1019):
--   * ONE new column `definition_scope_user_id` carries the owner;
--   * V101:27's `definition_scope_id` keeps its foreign key to `workspaces` and therefore only ever
--     holds a workspace id (it stays NULL on personal rows). Reusing that column would either break
--     the FK (writing a user id ⇒ 23503) or drop the workspace ON DELETE CASCADE (A1), which is how
--     a deleted workspace's private definitions would become orphan rows permanently occupying a
--     qualified name.
--   * the FK itself is left untouched ON PURPOSE: under A2 its meaning ("this row belongs to that
--     workspace") is exactly what it already says, so the migration never needs to know — let alone
--     guess — the constraint name PostgreSQL generated for it. Only the two explicitly named
--     constraints (V101:61 ck_skills_definition_scope, V101:70 uq_skills_qualified_name) are
--     dropped here; that is the whole reason this migration can be written without that name.
--
-- Why the new column is ON DELETE CASCADE while the value is "ownership integrity", not cleanup:
-- `skills.created_by_user_id` is NOT NULL ... ON DELETE RESTRICT (V101:58), so deleting a user who
-- created any definition is already refused before this column's cascade could fire. The new FK is
-- here so the owner id cannot dangle (no personal row may claim a non-existent user); the cascade
-- clause is the consistent choice for a column that only ever holds a users.id, and the honest
-- reading of its effect is "unobservable in this schema" (D-1027 judging rule).

-- ---------------------------------------------------------------------------------------------
-- 1) The owner column. Nullable by construction: instance and workspace rows keep it NULL.
-- ---------------------------------------------------------------------------------------------
ALTER TABLE skills ADD COLUMN definition_scope_user_id UUID
    REFERENCES users (id) ON DELETE CASCADE;

-- ---------------------------------------------------------------------------------------------
-- 2) Rebuild the CHECK with three arms + mutual exclusion (each arm pins BOTH scope columns).
--    The old two-arm form cannot express "type=user": it would accept a user row with both ids NULL
--    (and reject nothing), leaving "which library does this row belong to" undecidable.
-- ---------------------------------------------------------------------------------------------
ALTER TABLE skills DROP CONSTRAINT ck_skills_definition_scope;
ALTER TABLE skills ADD CONSTRAINT ck_skills_definition_scope
    CHECK ((definition_scope_type = 'instance'
                AND definition_scope_id IS NULL
                AND definition_scope_user_id IS NULL)
        OR (definition_scope_type = 'workspace'
                AND definition_scope_id IS NOT NULL
                AND definition_scope_user_id IS NULL)
        OR (definition_scope_type = 'user'
                AND definition_scope_id IS NULL
                AND definition_scope_user_id IS NOT NULL));

-- ---------------------------------------------------------------------------------------------
-- 3) Rebuild the unique key over FOUR columns.
--    (name, definition_scope_type, definition_scope_id) verbatim from V101:71, plus the owner column:
--      * name .................. the qualified name is part of the identity (README frozen #4);
--      * definition_scope_type . keeps `writing` (instance) apart from `writing` (a workspace or a
--                                user library) — the three layers coexist;
--      * definition_scope_id ... keeps two workspaces' same-named private definitions apart;
--      * definition_scope_user_id  keeps two USERS' same-named personal definitions apart. Without
--                                this column, NULLS NOT DISTINCT would collapse every personal row
--                                named `writing` into one key, so the second user's import would be
--                                a 23505 — the exact bug the fourth column exists to prevent.
--    NULLS NOT DISTINCT is retained from V101:70 (not decoration): instance rows store NULL scope ids
--    and two rows named `writing` in the instance library must collide (the V87 round-2 P0 trap).
--    Under A2 the existing rows' new column is NULL, so the four-column key is equivalent to the old
--    three-column key for every row that exists today — no new conflict surface, no cleanup step.
-- ---------------------------------------------------------------------------------------------
ALTER TABLE skills DROP CONSTRAINT uq_skills_qualified_name;
ALTER TABLE skills ADD CONSTRAINT uq_skills_qualified_name UNIQUE NULLS NOT DISTINCT
    (name, definition_scope_type, definition_scope_id, definition_scope_user_id);

-- ---------------------------------------------------------------------------------------------
-- 4) Listing index for the personal library. `idx_skills_definition_scope` (V101:74-75) is keyed on
--    (definition_scope_type, definition_scope_id, name) and cannot serve a lookup by owner (personal
--    rows carry a NULL definition_scope_id), so the owner listing gets its own partial index.
-- ---------------------------------------------------------------------------------------------
CREATE INDEX idx_skills_definition_scope_user
    ON skills (definition_scope_user_id, name)
    WHERE definition_scope_user_id IS NOT NULL;

-- ---------------------------------------------------------------------------------------------
-- 5) Atom seeds: MANAGE_PERSONAL_SKILLS (V156 / D-1019 / task-221).
--    Default-granted to every account ⇒ the USER role (instance tier, …0003) carries it, and
--    ADMIN/SUPER_ADMIN derive from the code-side catalog (ADMIN concat(USER_DEFAULT_ATOMS, …),
--    SUPER_ADMIN = every action atom), so both admin roles need their row as well.
--    Form copied from V153:35-38 (the newest minimal seed pattern): idempotent ON CONFLICT.
-- ---------------------------------------------------------------------------------------------
INSERT INTO role_permissions (role_id, action_class, resource_pattern) VALUES
    ('00000000-0000-4000-8000-000000000001', 'MANAGE_PERSONAL_SKILLS', '*'),  -- SUPER_ADMIN
    ('00000000-0000-4000-8000-000000000002', 'MANAGE_PERSONAL_SKILLS', '*'),  -- ADMIN
    ('00000000-0000-4000-8000-000000000003', 'MANAGE_PERSONAL_SKILLS', '*')   -- USER
ON CONFLICT (role_id, action_class, resource_pattern) DO NOTHING;

-- 5b) Instance-scope backfill for accounts that already exist (the seed row above only shapes the
--     role; a grant is materialised per subject). Same shape as V115:51-74: one row per
--     (subject, atom), skipped when the subject already holds the atom from a role.
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
                    '00000000-0000-4000-8000-000000000002',
                    '00000000-0000-4000-8000-000000000003')
  AND rp.action_class = 'MANAGE_PERSONAL_SKILLS'
  AND NOT EXISTS (
      SELECT 1 FROM grants g
      WHERE g.subject_type = 'user'
        AND g.subject_id = b.subject_id
        AND g.source = 'role'
        AND g.scope_type = 'instance'
        AND g.scope_id IS NULL
        AND g.permissions->0->>'actionClass' = rp.action_class);
