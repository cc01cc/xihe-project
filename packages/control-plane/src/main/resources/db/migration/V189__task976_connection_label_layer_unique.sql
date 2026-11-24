-- task-976 / R18 (D-206): connection display names are unique inside one owner layer.
-- Uniqueness domain = (owner_type, owner_id, lower(btrim(label))); the same label is
-- allowed across layers (INSTANCE vs USER vs WORKSPACE) but not twice inside one layer,
-- regardless of provider_id. The pre-existing provider-scoped index V79 is a strict
-- subset of this rule and stays in place (two independent indexes are harmless).
-- Hard uniqueness with a fail-fast preflight: no silent rename/delete. A blank or
-- duplicate label blocks this migration so an operator resolves it explicitly.
-- Detection SQL (evidence, run before applying on any existing database):
--   SELECT owner_type, owner_id, lower(btrim(label)), count(*)
--     FROM provider_connections
--    GROUP BY 1, 2, 3 HAVING count(*) > 1;
-- Rollback: DROP INDEX uq_provider_connections_owner_label; (no data change)
DO $$
DECLARE
    blanks BIGINT;
    duplicate_groups BIGINT;
BEGIN
    SELECT count(*) INTO blanks
      FROM provider_connections
     WHERE btrim(label) = '';

    SELECT count(*) INTO duplicate_groups
      FROM (
            SELECT 1
              FROM provider_connections
             GROUP BY owner_type, owner_id, lower(btrim(label))
            HAVING count(*) > 1
           ) duplicates;

    IF blanks > 0 OR duplicate_groups > 0 THEN
        RAISE EXCEPTION 'CONNECTION_LABEL_LAYER_PRECHECK_FAILED blanks=% duplicateGroups=%',
            blanks, duplicate_groups
            USING HINT = 'Resolve blank/duplicate labels first: SELECT owner_type, owner_id, lower(btrim(label)), count(*) FROM provider_connections GROUP BY 1,2,3 HAVING count(*) > 1;';
    END IF;
END $$;

CREATE UNIQUE INDEX uq_provider_connections_owner_label
    ON provider_connections (owner_type, owner_id, lower(btrim(label)));
