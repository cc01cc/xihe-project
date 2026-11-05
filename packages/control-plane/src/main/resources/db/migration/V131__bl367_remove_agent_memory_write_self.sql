-- BL-367 (P1 security, 2026-11-06): remove the agent-principal instance-scope
-- MEMORY_WRITE_SELF grant that the V129 backfill materialized on upgrade databases.
--
-- Why a new migration (not a V127 edit): V127 has been applied on more databases, and rewriting it
-- would change its Flyway checksum for every environment; a forward migration has the smaller cost
-- (same reasoning as V130).
--
-- Why it exists: MEMORY_WRITE_SELF is in PermissionAtomCatalog.AGENT_FORBIDDEN_ATOMS ("an agent is a
-- grantee, not a user-data owner"). V127's strip only removed CREATE_OWN_AGENT, and V130 only cleaned
-- workspace-scope SELF rows. On the upgrade path the V129 backfill could still leave an instance-scope
-- source='role' SELF grant on an agent_principal subject (e.g. a legacy USER-role binding that V127
-- did not rebind because it was not is_seed). That row must not survive an upgrade: it is exactly the
-- class of atom the runtime rejects with ROLE_NOT_GRANTABLE.
--
-- Scope: only agent_principal + instance scope + source='role' + SELF. Human USER/ADMIN instance SELF
-- grants are untouched. Idempotent (a re-run deletes zero rows). Reversible by re-materializing the
-- atom from a role that declares it — no agent role may do so, which is the point.

DELETE FROM grants g
WHERE g.subject_type = 'agent_principal'
  AND g.scope_type = 'instance'
  AND g.source = 'role'
  AND g.permissions @> '[{"actionClass": "MEMORY_WRITE_SELF"}]'::jsonb;
