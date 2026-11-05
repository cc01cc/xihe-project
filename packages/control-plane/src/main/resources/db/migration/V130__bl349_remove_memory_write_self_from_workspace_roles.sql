-- BL-349 (P0 regression from BL-345, found by e2e on the freeze round):
-- V129 granted MEMORY_WRITE_SELF to WS_OWNER / WS_EDITOR / WS_VIEWER. That atom is in
-- PermissionAtomCatalog.AGENT_FORBIDDEN_ATOMS ("agent is a grantee, not a user-data owner"), and
-- WS_* roles ARE bindable to agent principals ⇒ every "bind agent to workspace with a default
-- workspace role" call failed 403 ROLE_NOT_GRANTABLE (AgentPrincipalService:772/851), breaking
-- session-matrix-roles and workspace-agent-management.
--
-- Fix (Lead ruling 2026-11-06): workspace roles carry no SELF at all.
--   * "write my own subject" is provided by the human USER / ADMIN / SUPER_ADMIN roles (V129);
--   * "write any subject" is MEMORY_WRITE, which is NOT agent-forbidden and stays on WS_OWNER;
--   * WS_* must stay free of every agentPrincipalForbiddenAtoms atom — that is the existing design
--     constraint this migration restores.
--
-- No data backfill (D-215): deleting the role rows is configuration, and the only derived rows that
-- need cleanup are the stale source='role' workspace grants V129 materialized for SELF. They are
-- deleted below; re-materialization will not bring them back because the role no longer declares the
-- atom.
--
-- Idempotent: both DELETEs are naturally idempotent (a re-run deletes zero rows). Reversible: re-add
-- the three role_permissions rows and re-materialize the affected workspace bindings.

DELETE FROM role_permissions
WHERE role_id IN (
        '00000000-0000-4000-8000-000000000004', -- WS_OWNER
        '00000000-0000-4000-8000-000000000005', -- WS_EDITOR
        '00000000-0000-4000-8000-000000000006'  -- WS_VIEWER
    )
  AND action_class = 'MEMORY_WRITE_SELF';

-- Stale materialized grants from V129's workspace backfill: a workspace-scope role grant carrying
-- SELF no longer has a declaring role, so keeping it would leave an atom on agent subjects that the
-- role catalog says they must never hold. Instance-scope SELF grants (human USER/ADMIN) are kept.
DELETE FROM grants g
WHERE g.source = 'role'
  AND g.scope_type = 'workspace'
  AND g.permissions @> '[{"actionClass": "MEMORY_WRITE_SELF"}]'::jsonb;
