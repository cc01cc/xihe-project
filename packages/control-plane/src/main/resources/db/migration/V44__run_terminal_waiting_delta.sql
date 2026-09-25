-- PLAN-0407 V44 (delta-only; design #40): the two columns this plan still
-- needs after PLAN-0374 V42 (principal/workspace binding) and PLAN-0410 V43
-- (session branches). Nothing here rebuilds agent_principals,
-- sessions.agent_principal_id or the workspace_agents foreign keys.
--
-- operation_items.waiting_on_run_id: the single nullable durable waiting link
-- to the child ChatRun (spec/session/agent-spawn-terminal-lifecycle.md §3);
-- it is written by the spawn transaction and cleared inside the unified
-- terminal transaction (§4). No FK is declared here: the delta contract names
-- columns plus this lookup index only, and child run deletion must not fight
-- a database constraint before the terminal transaction settles the link.

ALTER TABLE operation_items
    ADD COLUMN waiting_on_run_id UUID;

CREATE INDEX idx_operation_items_waiting_on_run
    ON operation_items (waiting_on_run_id)
    WHERE waiting_on_run_id IS NOT NULL;

-- chat_runs.terminal_at: terminal transition timestamp written by the unified
-- terminal transaction (spec §4); nullable so every pre-V44 run stays valid.
-- No index: no delta query pattern is specified for it yet (minimal delta).
ALTER TABLE chat_runs
    ADD COLUMN terminal_at TIMESTAMPTZ;
