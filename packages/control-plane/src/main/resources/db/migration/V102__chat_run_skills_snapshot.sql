-- PLAN-0628 M2a (D28-35 / D28-39): freeze the skills listing a Run was admitted with.
--
-- Why a column and not a table: the snapshot is exactly one value per run, written once at
-- admission and read once at dispatch; a side table would add a join and its own lifecycle for no
-- benefit (D28-35).
-- Why jsonb NOT NULL DEFAULT '{}': same shape as context_template_snapshot. An absent snapshot must
-- stay distinguishable from "the run had no skills" — '{}' means "not captured" (legacy runs,
-- D28-40), while {"status":"empty"} means "captured, and the listing was empty".
--
-- Rollback: ALTER TABLE chat_runs DROP COLUMN skills_snapshot;

ALTER TABLE chat_runs
    ADD COLUMN skills_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN chat_runs.skills_snapshot IS
    'PLAN-0628 M2a: skills listing frozen at admission (D28-35). {} = not captured (legacy, D28-40); never means "no skills".';
