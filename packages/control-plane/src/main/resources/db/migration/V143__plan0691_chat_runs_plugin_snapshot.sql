-- PLAN-0691 T1.6b (design S4 / D-62): freeze the session plugin catalog a Run was admitted with.
--
-- Why a column and not a table: the snapshot is exactly one value per run, written once inside the
-- admission transaction and read by the tool-face filter; a side table would add a join and its own
-- lifecycle for no benefit (same reasoning as V102 skills_snapshot, PLAN-0628 D28-35).
-- Why jsonb NOT NULL DEFAULT '{}': an absent snapshot must stay distinguishable from "the run was
-- admitted with no plugins" — '{}' means "not captured" (plugin feature off, or a run created before
-- T1.6b), while {"catalogVersion":0,"items":[]} means "captured, and the attached set was empty".
--
-- Rollback: ALTER TABLE chat_runs DROP COLUMN plugin_snapshot;

ALTER TABLE chat_runs
    ADD COLUMN plugin_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN chat_runs.plugin_snapshot IS
    'PLAN-0691 T1.6b: session plugin catalog frozen at admission (D-62 "next turn, not this one"). {} = not captured; never means "no plugins".';
