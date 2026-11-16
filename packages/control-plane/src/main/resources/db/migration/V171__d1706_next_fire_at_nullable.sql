-- D-1706 ③ (stage-two prerequisite) + task-56:
-- scheduled_tasks.next_fire_at becomes NULLABLE.
--
-- Why: a time-triggered row always has a next fire instant, but the automation stage-two
-- "event" trigger has none — the event decides when it fires. Before this change the column was
-- NOT NULL (V58:32), so an event row would have had to carry a placeholder instant that looks
-- schedulable and would then be picked up by the due scan. NULL states exactly "there is no
-- scheduled instant".
--
-- Why a structural DROP NOT NULL and not a data backfill: dev-period data carries no migration
-- baggage (D-215). No existing row changes value; no dual read/write path is introduced.
--
-- Load-bearing consequences (pinned by tests, not left to convention):
--   * Every scan predicate compares next_fire_at with '<' / '=' (ScheduledTaskRepository).
--     SQL three-valued logic evaluates both to UNKNOWN when the operand is NULL, so a null row is
--     never discovered by the due scan, never claimed by claimToFiring, and never marked overdue.
--     For the claim path that means "UPDATE affects 0 rows and reports no error" — the scan treats
--     0 as a lost CAS race and continues, i.e. quietly never fires. ScheduledTaskNullabilityTest
--     asserts that 0-row result so stage two cannot mistake the old claim statement for reusable.
--   * Quota counting is status-based (countByWorkspaceIdAnd{UserIdAnd}StatusIn), so null rows keep
--     occupying their active slot — asserted too, so a future rewrite to a fire-time-based count
--     cannot silently hand out extra rows.
--
-- NOT added here on purpose: a CHECK of the shape
-- "next_fire_at IS NOT NULL OR trigger_kind = 'event'". There is no 'event' kind yet
-- (ck_scheduled_tasks_trigger_kind admits delay_once/cron/interval), so such a CHECK would forbid
-- exactly the null rows this migration exists to enable and would make the null-path tests
-- impossible to write. The kind-specific invariant arrives with the 'event' kind in stage two.
--
-- Reversible: ALTER TABLE scheduled_tasks ALTER COLUMN next_fire_at SET NOT NULL — only valid
-- while no row carries NULL (i.e. before stage two writes one).

ALTER TABLE scheduled_tasks ALTER COLUMN next_fire_at DROP NOT NULL;

COMMENT ON COLUMN scheduled_tasks.next_fire_at IS
    'Next scheduled fire instant (UTC). NULL = no scheduled instant (event-triggered rows, D-1706 ③); a NULL row is invisible to the due scan and unclaimable by claimToFiring.';
