-- 2026-11-04 ruling (task-25, Lead-approved): SPAWN_AGENT becomes a workspace-scoped action atom
-- and gets its own non-administrative role, so an agent principal can be granted delegation.
--
-- Why this migration exists
--   * SPAWN_AGENT used to sit in PermissionAtomCatalog.INSTANCE_ONLY_ATOMS (decision #27 listed
--     "agent spawning" as an instance action). Its actual effect is "create a child Session/Run
--     inside the SAME workspace", and the authorization path
--     (AgentSpawnAuthorizationService -> GrantAuthorizationService.allows) resolves the SESSION's
--     agent principal grants, never the human's. The instance-only class therefore blocked both
--     the workspace binding (400 ROLE_SCOPE_MISMATCH) and every agent principal
--     (agentPrincipalForbiddenAtoms() includes the instance-only set) — delegation was impossible
--     regardless of which role was bound.
--   * Code side: PermissionAtomCatalog drops the atom from INSTANCE_ONLY_ATOMS;
--     SystemAccessRoleCatalog.roleSeeds() gains this role, so H2/entity-built schemas and
--     PostgreSQL agree (DynamicAccessRoleMigrationTest / AgentDelegatorAtomTierTest assert parity).
--
-- Scope of the grant matrix (deliberate, minimal): this migration seeds ONLY the role definition.
--   * No `grants` backfill: nothing is granted by default; a workspace owner / instance admin hands
--     AGENT_DELEGATOR out explicitly (least privilege; the Session agentPermissionsSnapshot freezes
--     at creation, so "when it was granted" stays observable).
--   * WS_OWNER / WS_EDITOR atom sets are intentionally untouched in this round (separate ruling on
--     "who may expand the session tree and spend provider quota").
--
-- Idempotent: both statements are no-ops on a database that already applied this script or that was
-- bootstrapped by SystemAccessRoleCatalog.ensureSeeded().
-- Reversible: DELETE FROM roles WHERE name = 'AGENT_DELEGATOR' cascades role_permissions.

INSERT INTO roles (id, name, display_name, description, is_system) VALUES
    ('00000000-0000-4000-8000-000000000007', 'AGENT_DELEGATOR', 'Agent Delegator',
     'Workspace scope: delegate by creating child Sessions/Runs inside the same workspace. '
     'Intended for agent principals; bound explicitly.', TRUE)
ON CONFLICT (name) DO NOTHING;

INSERT INTO role_permissions (role_id, action_class, resource_pattern)
SELECT id, 'SPAWN_AGENT', '*'
FROM roles
WHERE name = 'AGENT_DELEGATOR'
ON CONFLICT (role_id, action_class, resource_pattern) DO NOTHING;
