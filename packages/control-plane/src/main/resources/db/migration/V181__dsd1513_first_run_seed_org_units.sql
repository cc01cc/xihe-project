-- V181 (DSD-1513 / task-148): the first-run content seed's ORG TREE half, plus the i18n column.
--
-- WHY THIS FILE EXISTS (DSD-1520 D1, "按表分界")
--   DSD-1520 D1 splits the first-run seed by TABLE, and the split is not cosmetic:
--     * org_units rows            -> this migration (pure static data: fixed sentinel ids,
--                                    fixed name/path/depth, zero runtime input)
--     * agent_principals / provider_connections / workspaces / org_unit_members
--                                 -> Java seeder (config/FirstRunContentSeeder.java)
--   The two halves write DISJOINT tables, so no row can ever be seeded twice. The reason the unit
--   rows belong here rather than in the seeder is that they need nothing at runtime: a seeder that
--   inserts them would have to call OrgUnitWriteRepository.insert (a bare INSERT with no upsert) and
--   re-invent ON CONFLICT in Java, and it would split "where does the org tree come from" across two
--   files -- V167 already froze the migration-side spelling of this seed.
--
-- WHY name_key IS A SEPARATE COLUMN AND NOT A TRANSLATED "name"
--   DSD-1520 D3 took option (c): keep the stored name (the zh literal, also the fallback for any
--   row a user created), add a nullable i18n key, and translate AT THE READ FACE
--   (service/OrgUnitReadService.java + config/OrgUnitNameKeys.java). The wire response stays ONE
--   string (controller/OrgUnitWireView.java Node.name) -- never a {zh,en} pair, so the UI cannot
--   grow a second source of truth (same principle as policy/PermissionAtomLabels.java).
--   name_key IS NULL means "nothing to translate". A user who renames a seeded unit gets
--   name_key = NULL written in the same UPDATE (repository/OrgUnitWriteRepository.rename, DSD-1520
--   Q2), so a rename can never be shadowed by a stale seed label.
--
-- WHY THE IDS ARE FIXED SENTINELS
--   The Java half must be able to name these units WITHOUT a lookup (the same argument V167:22-30
--   gives for the root): "the child of the root" is not a stable identity once an operator is
--   allowed to create a second child, and several roots are legitimate. Literal ids keep both halves
--   pinned to each other, and OrgUnitRootSeedIntegrationTest asserts they still agree.
--
-- IDEMPOTENCY (a seed is judged by the replay, not by "it ran once")
--   Every INSERT is ON CONFLICT DO NOTHING (untargeted, for the reason V167:44-52 gives: the
--   collision can be the primary key OR uq_org_units_path, and either means "already there").
--   The backfill UPDATE carries `AND name_key IS NULL`, so a replay affects 0 rows. The assertions
--   live in migration/FirstRunSeedOrgUnitMigrationTest and, for the tree shape, in
--   migration/OrgUnitRootSeedMigrationTest.
--
-- NUMBER ALLOCATION (taken with the gate, not by hand)
--   cd A03-xihe && node scripts/check-migration-numbers.mjs
--     => [migration-numbers] files=172 max=V180 next=V181 registeredRows=193, exit 0
--   after writing, before registering => E_MIGRATION_NOT_REGISTERED (registering V181 in
--   one/internal/A03-xihe/docs/migration-numbers.md is outside this card's write scopes and is
--   tracked in the evidence file's §5).
--
-- SHAPE (matches V163's DDL exactly, no new constraint is introduced)
--   ck_org_units_root            (parent_id IS NULL) = (depth = 0)     -> e1 root, e2/e3 children
--   ck_org_units_path_no_hyphen  path::text !~ '-'                      -> labels are ids without '-'
--   uq_org_units_path            UNIQUE (path)                          -> the second conflict target
--   uq_org_units_sibling_name    UNIQUE NULLS NOT DISTINCT (parent_id, name)

ALTER TABLE org_units ADD COLUMN name_key VARCHAR(120);

COMMENT ON COLUMN org_units.name_key IS
    'PLAN-0773 / DSD-1520 D3(c): i18n key for a SEEDED unit name. NULL = nothing to translate '
    '(every user-created or user-renamed unit). Translated at the read face by '
    'config/OrgUnitNameKeys.java; the wire response stays a single string.';

-- The V167 root: its name is the zh literal (kept as the fallback), the key is what makes it
-- translatable. Guarded on IS NULL so the replay is a no-op.
UPDATE org_units
   SET name_key = 'orgUnit.seedRoot'
 WHERE id = '00000000-0000-4000-8000-0000000000e1'
   AND name_key IS NULL;

-- Two child units: 负责人组 (the lead group) and its child 执行组 (the execution group). depth and
-- path follow D-1116: path = parent path + '.' + this id without hyphens, depth = parent depth + 1.
INSERT INTO org_units (id, parent_id, name, name_key, path, depth) VALUES
    ('00000000-0000-4000-8000-0000000000e2',
     '00000000-0000-4000-8000-0000000000e1',
     '负责人组', 'orgUnit.seedLeaders',
     '000000000000400080000000000000e1.000000000000400080000000000000e2', 1),
    ('00000000-0000-4000-8000-0000000000e3',
     '00000000-0000-4000-8000-0000000000e2',
     '执行组', 'orgUnit.seedExecution',
     '000000000000400080000000000000e1.000000000000400080000000000000e2.000000000000400080000000000000e3', 2)
ON CONFLICT DO NOTHING;
