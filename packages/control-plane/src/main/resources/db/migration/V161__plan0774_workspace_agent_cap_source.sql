-- V161 (D-1109 / task-64 46A+47A): record HOW a frozen workspace-agent cap came to be.
--
-- Why: `permissions` becomes optional on PUT /api/v1/workspaces/{workspaceId}/agents/{principalId}.
-- Omitting it inherits the principal's role baseline in this Workspace, and the store has to keep
-- "the caller forgot the field" distinguishable from "the caller chose to inherit" (D-1109 guard 1).
-- This column is provenance only: the cap's VALUE and the read path (resolveCapFor's
-- snapshot ∩ effective-atoms intersection) are untouched.
--
-- Semantics:
--   explicit -> the caller sent `permissions`. An empty array is an explicit ZERO cap; the
--               "[] means inherit" reading was refused upstream (D-1109 guard 3 / 46C).
--   baseline -> the caller omitted `permissions`; the cap was derived from the role baseline
--               (the subject's source='role' grants in this workspace, or the seeded default
--               role the structural binding creates when none is bound yet).
-- Legacy rows: 'explicit' is the honest label - every existing row was written from a
-- caller-supplied array by AgentPrincipalService.setWorkspaceCap before this change.
ALTER TABLE workspace_agents
    ADD COLUMN cap_source varchar(16) NOT NULL DEFAULT 'explicit';

ALTER TABLE workspace_agents
    ADD CONSTRAINT workspace_agents_cap_source_check
    CHECK (cap_source IN ('baseline', 'explicit'));

COMMENT ON COLUMN workspace_agents.cap_source IS
    'D-1109 (2026-11-13): provenance of the frozen cap. explicit = the caller supplied the permissions array ([] = zero cap); baseline = the caller omitted it and the cap was derived from the role baseline in this workspace.';
