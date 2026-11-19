-- V177 (task-106 / user ruling 2026-11-20 00:28, option A): workspace-scoped default agent.
--
-- Why: creating a session without an explicit agentPrincipalId was a hard 400 even when the
-- workspace already had one obvious agent. Users asked for "the workspace agent" to be pre-selected
-- by the create form, and the choice has to be authoritative server-side too (the CLI and the Agent
-- side call the same path), so it is stored on the binding row rather than only in config.
--
-- Semantics:
--   is_default = true  -> this workspace agent is the fallback for sessions created without an
--                         agentPrincipalId (PUT /api/v1/workspaces/{workspaceId}/agents/{principalId}/default).
--   is_default = false -> ordinary binding (the legacy default, so existing rows are untouched).
--
-- Uniqueness: at most one default per workspace. The predicate is just is_default because this table
-- has no soft delete (V42 owns the composite PK; a binding is either present or deleted), so the
-- "where is_default and deleted_at is null" wording from the card has nothing to exclude here.
--
-- Rollback (no undo script in this repo, 168 forward migrations and no undo segments): dropping
-- ux_workspace_agents_default first, then ALTER TABLE workspace_agents DROP COLUMN is_default, restores
-- the V176 shape without residue — no other table, index or constraint references the column.

ALTER TABLE workspace_agents
    ADD COLUMN is_default boolean NOT NULL DEFAULT false;

CREATE UNIQUE INDEX ux_workspace_agents_default
    ON workspace_agents (workspace_id) WHERE is_default;

COMMENT ON COLUMN workspace_agents.is_default IS
    'task-106: workspace-scoped default agent for new sessions; at most one true row per workspace_id (partial unique index ux_workspace_agents_default).';
