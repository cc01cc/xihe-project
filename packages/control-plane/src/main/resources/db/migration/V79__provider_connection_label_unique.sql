-- PLAN-0555: connection display names must be unique inside one owner + provider.
-- B: hard uniqueness with a fail-fast preflight. No silent renames: a blank or
-- duplicate label blocks this migration so an operator resolves it explicitly.
-- Rollback: DROP INDEX uq_provider_connections_owner_provider_label; (no data change)
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
             GROUP BY owner_type, owner_id, provider_id, lower(btrim(label))
            HAVING count(*) > 1
           ) duplicates;

    IF blanks > 0 OR duplicate_groups > 0 THEN
        RAISE EXCEPTION 'CONNECTION_LABEL_PRECHECK_FAILED blanks=% duplicateGroups=%',
            blanks, duplicate_groups
            USING HINT = 'Resolve blank/duplicate labels first: SELECT owner_type, owner_id, provider_id, lower(btrim(label)), count(*) FROM provider_connections GROUP BY 1,2,3,4 HAVING count(*) > 1;';
    END IF;
END $$;

CREATE UNIQUE INDEX uq_provider_connections_owner_provider_label
    ON provider_connections (owner_type, owner_id, provider_id, lower(btrim(label)));
