-- PLAN-0705 / BL-515: inverse of V145__plan0647_workspaceless_sessions.sql (D-678).
--
-- Rollback is blocked, never silent, while any of the four relaxed columns still holds NULL:
-- a machine-readable precheck lists every offending table.column together with its row count,
-- then the script restores NOT NULL in reverse migration order and drops the pure-chat index.
-- Idempotent: a column that is already NOT NULL is skipped, so a retried rollback is safe.

DO $$
DECLARE
    offenders text := '';
    n bigint;
BEGIN
    SELECT count(*) INTO n FROM sessions WHERE workspace_id IS NULL;
    IF n > 0 THEN offenders := offenders || format('sessions.workspace_id=%s rows; ', n); END IF;
    SELECT count(*) INTO n FROM chat_runs WHERE workspace_id IS NULL;
    IF n > 0 THEN offenders := offenders || format('chat_runs.workspace_id=%s rows; ', n); END IF;
    SELECT count(*) INTO n FROM context_events WHERE workspace_id IS NULL;
    IF n > 0 THEN offenders := offenders || format('context_events.workspace_id=%s rows; ', n); END IF;
    SELECT count(*) INTO n FROM context_projections WHERE workspace_id IS NULL;
    IF n > 0 THEN offenders := offenders || format('context_projections.workspace_id=%s rows; ', n); END IF;
    IF offenders <> '' THEN
        RAISE EXCEPTION 'V145 rollback blocked by NULL workspace_id: %', offenders;
    END IF;
END $$;

DROP INDEX IF EXISTS idx_sessions_user_active_no_workspace;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_name = 'context_projections' AND column_name = 'workspace_id'
                 AND is_nullable = 'YES') THEN
        ALTER TABLE context_projections ALTER COLUMN workspace_id SET NOT NULL;
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_name = 'context_events' AND column_name = 'workspace_id'
                 AND is_nullable = 'YES') THEN
        ALTER TABLE context_events ALTER COLUMN workspace_id SET NOT NULL;
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_name = 'chat_runs' AND column_name = 'workspace_id'
                 AND is_nullable = 'YES') THEN
        ALTER TABLE chat_runs ALTER COLUMN workspace_id SET NOT NULL;
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_name = 'sessions' AND column_name = 'workspace_id'
                 AND is_nullable = 'YES') THEN
        ALTER TABLE sessions ALTER COLUMN workspace_id SET NOT NULL;
    END IF;
END $$;
