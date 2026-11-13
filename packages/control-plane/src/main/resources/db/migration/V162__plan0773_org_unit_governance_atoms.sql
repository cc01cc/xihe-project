-- V162 (PLAN-0773 / M2-2): the three org-unit governance atoms enter the vocabulary.
--
-- Atoms (D-1118 = the whitelist of OrgUnitGovernancePolicy, task-146):
--   MANAGE_ORG_UNITS        create / rename / move / delete an org unit
--   MANAGE_ORG_UNIT_MEMBERS add / remove / re-role the members of one org unit
--   READ_ORG_UNIT_MEMBERS   see the member list of one org unit
-- A role may be bound inside an org unit only when its atom set is a subset of these three
-- (OrgUnitGovernancePolicy.isGovernanceRole). M2-3 seeds ORG_LEADER exactly that way; this
-- migration deliberately seeds NO governance role — that is M2-3's card.
--
-- Number allocation (three checks, run at 2026-11-13 08:5x, recorded because the card forbids
-- pre-reserving a number):
--   1) base sha          = 039d3f15e (develop HEAD when the checks ran)
--   2) numeric max       = V161 (`V19` > `V100` under string sort, so the scan sorts by int)
--   3) max+1             = V162; `V162*`/`V163*` files in the tree = 0;
--      `git log --all -- V162*` = 0 hits; flyway_schema_history max applied = 161
--
-- CONFLICT, recorded rather than silently resolved: task-145 reserved V162 for M1-1 in its card.
-- A gap is not an option — with outOfOrder disabled, applying V163 and later adding V162 makes
-- every existing database fail at startup with "Detected resolved migration not applied". The
-- repository rule is "number = develop max + 1 at merge time, first merge wins" and the precedent
-- is V140, which was retired because V141 merged first. So this card takes V162 and M1-1 renumbers;
-- reported to the Lead for acknowledgement instead of quietly leaving a hole.
--
-- Default grant set: SUPER_ADMIN only. Not a privilege design — it is the mirror mandate of
-- DefaultSetMigrationParityTest ("SUPER_ADMIN must materialize every action atom plus every
-- capability atom"), so an atom in the catalog without this row leaves the parity test red (the
-- same rule V153 / V156 / V157 document). ADMIN and the ORG_LEADER seeds belong to M2-3
-- (default grant set), which is why this file adds no ADMIN row: adding one here would decide a
-- default set that the plan assigns to a different card.
--
-- Scope class: NOT decided by this migration. The three atoms are absent from
-- PermissionAtomCatalog.INSTANCE_ONLY_ATOMS, so they fall into `both` — a state, not a ruling.
-- 〔待 M2-8c 定〕: whether an org-unit grant is evaluated as a new scope family or projected onto
-- an existing scope decides the class; `Atom.bindableIn` makes an `instance`-class atom unusable
-- in any non-instance scope, so guessing `instance` here would silently break org-unit binding.

-- ---------------------------------------------------------------------------------------------
-- 1) The role seed row (3 rows). Form copied from V157:35-44 — idempotent, so a re-run is a no-op.
-- ---------------------------------------------------------------------------------------------
INSERT INTO role_permissions (role_id, action_class, resource_pattern) VALUES
    ('00000000-0000-4000-8000-000000000001', 'MANAGE_ORG_UNITS', '*'),        -- SUPER_ADMIN
    ('00000000-0000-4000-8000-000000000001', 'MANAGE_ORG_UNIT_MEMBERS', '*'), -- SUPER_ADMIN
    ('00000000-0000-4000-8000-000000000001', 'READ_ORG_UNIT_MEMBERS', '*')    -- SUPER_ADMIN
ON CONFLICT (role_id, action_class, resource_pattern) DO NOTHING;

-- ---------------------------------------------------------------------------------------------
-- 2) Materialize the new atoms for grantee rows that already exist (same shape as V157:62-88).
--    A seed row shapes the ROLE; a grant is materialized per subject × scope
--    (RoleGrantMaterializer). Without this backfill an existing SUPER_ADMIN would be missing the
--    three atoms until something re-materialized its role, i.e. the vocabulary would be correct
--    and the effective grants would not. Scope comes from the binding (ck_role_bindings_scope),
--    never written literally.
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
WHERE rp.action_class IN ('MANAGE_ORG_UNITS', 'MANAGE_ORG_UNIT_MEMBERS', 'READ_ORG_UNIT_MEMBERS')
  AND b.role_id = '00000000-0000-4000-8000-000000000001'  -- SUPER_ADMIN
  AND NOT EXISTS (
      SELECT 1 FROM grants g
      WHERE g.subject_type = b.subject_type
        AND g.subject_id = b.subject_id
        AND g.source = 'role'
        AND g.scope_type = b.scope_type
        AND g.scope_id IS NOT DISTINCT FROM b.scope_id
        AND g.permissions->0->>'actionClass' = rp.action_class);
