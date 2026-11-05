-- PLAN-0651 D-174 (user ruling 2026-11-05): the agent-principal PERSONAL/WORKSPACE/INSTANCE tier
-- is removed completely — API / query / response / entity / DB. Role-binding scope (instance vs
-- workspace) and the owner column are NOT part of this removal.
--
-- Number: V126 taken while designing (main/worktree max was V125 at that moment). NOT merged yet —
-- re-run the three checks (main / other worktrees / flyway_schema_history) at merge time and rename
-- if a lane took V126 meanwhile. No data deletion beyond the tier column itself:
--   * owner_user_id stays (legacy PERSONAL rows keep their owner; NO backfill per Lead ruling —
--     INSTANCE rows are not given owners, and no row gains a guessed owner);
--   * audit_logs/details keep historical "scope" strings (they are records, not schema).
--
-- Reversible: re-ADD the column + constraints from V90 (values: every surviving row was the
-- backfilled/created 'WORKSPACE' for pre-existing rows, and rows created after D-174 carry no
-- tier meaning — a rollback would need to re-derive it, which is why this is one-shot).

-- 1. Owner/tier coupling first: the CHECK ties owner to scope, so it must fall before the column.
ALTER TABLE agent_principals DROP CONSTRAINT IF EXISTS ck_agent_principals_owner;
ALTER TABLE agent_principals DROP CONSTRAINT IF EXISTS ck_agent_principals_scope;

-- 2. The scope column itself (tier) goes; the owner column and its FK stay.
ALTER TABLE agent_principals DROP COLUMN IF EXISTS scope;

-- 3. Replace the (scope, owner) index with the access pattern that remains: owner lookups.
DROP INDEX IF EXISTS idx_agent_principals_scope_owner;
CREATE INDEX IF NOT EXISTS idx_agent_principals_owner ON agent_principals (owner_user_id);
