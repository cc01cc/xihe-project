-- V159 (task-221 / V156 follow-up, D-1019 + AGENT_FORBIDDEN_ATOMS): strip the instance-scope
-- MANAGE_PERSONAL_SKILLS grant that an upgrade database can leave on an agent principal.
--
-- Why a new migration (not a V156 edit): V156 has been applied on more databases, and rewriting it
-- would change its Flyway checksum for every environment; a forward migration has the smaller cost
-- (same reasoning as V131).
--
-- Why the row can exist: MANAGE_PERSONAL_SKILLS is seeded onto the human USER role (V156:85) and
-- V156's backfill only materializes it for `subject_type = 'user'` (V156:90-110). But an agent
-- principal bound to the human USER role — exactly the legacy shape V127 rebinds — is materialized
-- from that same role seed, so before this migration such an agent keeps the atom. It is in
-- PermissionAtomCatalog.AGENT_FORBIDDEN_ATOMS (PermissionAtomCatalog.java:137-139: "a personal
-- library belongs to one human account; an agent principal has no personal library of its own"),
-- so the row must not survive an upgrade: it is the same class of atom the service refuses with
-- ROLE_NOT_GRANTABLE, and AgentUserSeedMigrationUpgradeTest asserts it via
-- firstForbiddenAgentPrincipalAtom.
--
-- Scope: agent_principal + instance scope + source='role' + that one atom. Human USER/ADMIN rows are
-- untouched. No workspace role seeds the atom, so unlike V130 there is no workspace-scope arm to
-- clean. Idempotent (a re-run deletes zero rows); reversible by re-materializing the atom from a
-- role that declares it — no agent-bindable role may, which is the point.
DELETE FROM grants g
WHERE g.subject_type = 'agent_principal'
  AND g.scope_type = 'instance'
  AND g.source = 'role'
  AND g.permissions @> '[{"actionClass": "MANAGE_PERSONAL_SKILLS"}]'::jsonb;
