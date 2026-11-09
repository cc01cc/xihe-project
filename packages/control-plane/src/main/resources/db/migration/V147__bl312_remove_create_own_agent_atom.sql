-- BL-312 (option B, user ruling 2026-11-09 / D-759②): remove the CREATE_OWN_AGENT atom from the
-- data plane. This is the inverse of V91's seeding and the SQL half of the catalog removal that
-- lands in the same commit (PermissionAtomCatalog / SystemAccessRoleCatalog / ToolFaceRegistry /
-- PermissionAtomLabels); DynamicAccessRoleMigrationTest and DefaultSetMigrationParityTest keep the
-- roleSeeds() <-> migration rows parity in both directions.
--
-- What V91 planted (and what happened to it since):
--   * role_permissions: one CREATE_OWN_AGENT row each for SUPER_ADMIN / ADMIN / USER (…0001/0002/0003).
--   * grants: one materialized source='role' instance row per already-bound user subject
--     (DISTINCT ON subject_id backfill). V127 stripped the agent_principal rows of the same shape;
--     V146 cleared the source='agent_default' rows; the user-subject rows survived until here.
--
-- Statement 1 deletes by action_class regardless of resource_pattern and role, so a custom role
-- that was handed the atom is cleaned up too ("delete the atom" semantics). Statement 2 mirrors
-- V127's strip shape for user subjects; after statement 1 the NOT EXISTS guard is trivially true,
-- it is kept to express the intent (only rows whose backing role permission is gone are removed).
-- The scope filter is deliberately omitted: source='role' rows carrying this atom are dead by
-- definition once no role definition carries it, in every scope.
--
-- Reversible: re-apply V91's two INSERT statements (they are ON CONFLICT / NOT EXISTS idempotent)
-- after re-adding the atom to the code-side catalog.

DELETE FROM role_permissions
WHERE action_class = 'CREATE_OWN_AGENT';

DELETE FROM grants g
WHERE g.source = 'role'
  AND g.permissions @> '[{"actionClass": "CREATE_OWN_AGENT"}]'::jsonb
  AND NOT EXISTS (
      SELECT 1 FROM role_permissions rp
      WHERE rp.action_class = 'CREATE_OWN_AGENT');

-- Zero-omission verification (atom-contract §5.1): after this migration no role definition and no
-- source='role' materialization may still carry the atom. Anything surviving means an unexpected
-- population, so abort (fail the migration) instead of leaving a half-removed atom behind.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM role_permissions
        WHERE action_class = 'CREATE_OWN_AGENT'
    ) THEN
        RAISE EXCEPTION 'V147 aborted: role_permissions still carries CREATE_OWN_AGENT after the removal';
    END IF;
    IF EXISTS (
        SELECT 1 FROM grants
        WHERE source = 'role'
          AND permissions @> '[{"actionClass": "CREATE_OWN_AGENT"}]'::jsonb
    ) THEN
        RAISE EXCEPTION 'V147 aborted: source=role grants still carry CREATE_OWN_AGENT after the removal';
    END IF;
END $$;
