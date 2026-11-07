-- PLAN-0689 A7 (D-54): drop ONLY sessions.agent_principal_id. Session identity now lives on
-- session_participants (PRIMARY row) and every run carries its own agent_principal_id stamp.
--
-- agent_permissions_snapshot is deliberately retained. It is an authorization input, not identity:
-- GrantAuthorizationService (via SessionReadService) intersects it as the path cap, and a NULL or
-- non-array value makes GrantIntersectionEvaluator.parse throw, which the authorization layer turns
-- into a fail-closed refusal. Its semantics are now "the PRIMARY principal's cap frozen at binding
-- time"; the write points are SessionService (create/fork) and ChatSubmissionService (spawn at
-- :567/:724), fed by AgentPrincipalService.resolveCapFor under the requireActiveWorkspaceBinding
-- gate (D-49).
--
-- Index -> FK -> column keeps the drop order explicit and leaves no orphaned index/constraint.
-- Development data has no migration burden (D-215).
DROP INDEX IF EXISTS idx_sessions_agent_principal_id;

ALTER TABLE sessions DROP CONSTRAINT IF EXISTS fk_sessions_agent_principal;

ALTER TABLE sessions DROP COLUMN IF EXISTS agent_principal_id;
