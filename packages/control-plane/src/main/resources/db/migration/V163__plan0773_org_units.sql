-- V163 (PLAN-0773 / M1-1): the org-unit tree. First table of the M1 chain (M1-2/3/4/6/7/8/9 all
-- hang off it), so this file only SHAPES the table: no seed rows (M1-6), no ring-prevention
-- trigger (M1-3), no subtree move (M1-4), no member table (M1-2).
--
-- Shape comes from design.md 3.1. Two places where the obvious form is silently wrong:
--
--   1. UNIQUE (parent_id, name) must be NULLS NOT DISTINCT. A root has parent_id = NULL and
--      plain UNIQUE treats every NULL as distinct => two root units could both be named the same,
--      which is exactly the duplicate D-1116 forbids (tasks.md:22 reason 2: a UI hint cannot
--      repair two units with one name -- it can only say "exists", the user wants "only one").
--      Precedent: V101:70 uses NULLS NOT DISTINCT for the same NULL-means-instance shape.
--      Without the keyword the constraint looks right and enforces the wrong thing.
--
--   2. Each path label is a UUID with its hyphens removed (D-1116). MEASURED CORRECTION: the
--      stated reason ("ltree labels cannot contain -") is FALSE on this database. On
--      PostgreSQL 17.10 (a03-xihe-postgres-1) a hyphen is an ordinary label character:
--          SELECT 'aaa-bbb'::ltree;                       -- succeeds, nlevel = 1
--          SELECT 'root.<raw uuid with dashes>'::ltree;    -- succeeds, nlevel = 2
--          SELECT 'a b'::ltree / 'a*b'::ltree / 'a:b'::ltree;  -- rejected (space, *, :)
--      Older PG versions rejected the hyphen, and design.md 3.1 was written on that assumption;
--      this database is PG 17. So the de-hyphenated form is OUR rule, not the database one, and
--      nothing would enforce it if it stayed a comment. Hence the CHECK below: it is load-bearing
--      precisely because the database ACCEPTS the forbidden shape.
--      Keeping the rule is still right -- one spelling for every path means subtree/prefix
--      comparisons (path <@, subpath) and any regex acceptance check have exactly one form to
--      reason about, instead of two that compare byte-wise differently.
--
-- path is a materialized index, NOT a second source of truth: parent_id is the truth and the
-- writer maintains path in the same transaction (design.md 3.1). Nothing here derives one from
-- the other -- that belongs to the writer (M1-4 move / M1-6 seed).
-- The literal leading "root" segment in design.md 3.1 is an EXAMPLE, not a constraint, so it is
-- deliberately NOT enforced: which prefix a root gets is decided by the seeder (M1-6).
--
-- Number allocation was taken with the gate rather than by hand (task-164 / task-169):
--   before writing : node scripts/check-migration-numbers.mjs => files=154 max=V162 next=V163
--   after writing, before registering => E_MIGRATION_NOT_REGISTERED (the gate is really wired)
--   base sha at write time = efc94d104 (2026-11-13)
--
-- ltree must be installed BY THIS MIGRATION (tasks.md:21): M1-8 runs the whole chain against an
-- EMPTY database, and an empty database never saw the manual CREATE EXTENSION from M0-1. Relying
-- on that manual step means green on my machine, red on an empty database.

CREATE EXTENSION IF NOT EXISTS ltree;

CREATE TABLE org_units (
    id          UUID PRIMARY KEY,
    parent_id   UUID REFERENCES org_units (id) ON DELETE RESTRICT,
    name        VARCHAR(120) NOT NULL,
    path        LTREE NOT NULL,
    depth       INT NOT NULL CHECK (depth >= 0),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_org_units_path UNIQUE (path),
    -- NULLS NOT DISTINCT: two ROOTS are two rows with parent_id NULL. Plain UNIQUE would let them
    -- share a name (every NULL is distinct), i.e. enforce nothing for the one case that has no
    -- parent to disambiguate. See header reason 1.
    CONSTRAINT uq_org_units_sibling_name UNIQUE NULLS NOT DISTINCT (parent_id, name),
    -- A root has no parent and depth 0; a non-root has both. Keeps depth from drifting away from
    -- parent_id in a direction no query would notice.
    CONSTRAINT ck_org_units_root CHECK ((parent_id IS NULL) = (depth = 0)),
    -- D-1116, and NOT redundant: PG 17 accepts a hyphen inside an ltree label (header reason 2),
    -- so a path built from a raw UUID would be stored happily and look correct until something
    -- compared two spellings of the same unit. This CHECK is the only place the rule exists.
    CONSTRAINT ck_org_units_path_no_hyphen CHECK (path::text !~ '-')
);

-- Two indexes, one per access shape (design.md 3.1): the child-list / FK check walks parent_id,
-- every subtree question (who is under U) walks path <@, which needs GIST on ltree.
CREATE INDEX idx_org_units_parent ON org_units (parent_id);
CREATE INDEX idx_org_units_path ON org_units USING GIST (path);
