-- PLAN-0720 / BL-312 (option A, Lead ruling 2026-11-09): remove the zero-effect
-- `source='agent_default'` grants that still carry CREATE_OWN_AGENT.
--
-- Why this is safe: CREATE_OWN_AGENT has no authorization reader (rg ACTION_OWN_AGENT in main
-- code only hits the constant/catalog/labels/USER seed). V127 already stripped the `source='role'`
-- rows for the same atom; these agent_default rows are inert historical materialization.
--
-- Why the guard: the legacy stack-1 residue is exactly 2 rows (BL-312). A fresh database has 0.
-- Anything else means an unexpected population, so abort before deleting anything rather than
-- silently widening the blast radius.
--
-- Scope: only source='agent_default' AND permissions @> CREATE_OWN_AGENT. `source='role'` rows and
-- every other atom are untouched. B (USER seed / PermissionAtomCatalog / GrantDefaultService
-- removal) is a visible RBAC change and stays blocked on an explicit user ruling.

DO $$
DECLARE
    residual integer;
BEGIN
    SELECT count(*) INTO residual
    FROM grants
    WHERE source = 'agent_default'
      AND permissions @> '[{"actionClass": "CREATE_OWN_AGENT"}]'::jsonb;

    IF residual NOT IN (0, 2) THEN
        RAISE EXCEPTION 'V146 aborted: expected 0 (fresh DB) or 2 (BL-312 residue) agent_default CREATE_OWN_AGENT rows, found %', residual;
    END IF;
END $$;

DELETE FROM grants
WHERE source = 'agent_default'
  AND permissions @> '[{"actionClass": "CREATE_OWN_AGENT"}]'::jsonb;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM grants
        WHERE source = 'agent_default'
          AND permissions @> '[{"actionClass": "CREATE_OWN_AGENT"}]'::jsonb
    ) THEN
        RAISE EXCEPTION 'V146 aborted: agent_default CREATE_OWN_AGENT rows survived the cleanup';
    END IF;
END $$;
