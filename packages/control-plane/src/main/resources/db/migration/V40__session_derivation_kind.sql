-- PLAN-0407 T2.2: distinguish spawned descendants from independent forks.

ALTER TABLE sessions
    ADD COLUMN kind VARCHAR(16);

-- No fork creator shipped before V40; existing provenance rows therefore came from spawn.
UPDATE sessions
SET kind = 'spawn'
WHERE spawned_from_session_id IS NOT NULL
   OR spawned_from_run_id IS NOT NULL
   OR spawned_at IS NOT NULL;

ALTER TABLE sessions
    ADD CONSTRAINT ck_sessions_kind
        CHECK (kind IS NULL OR kind IN ('spawn', 'fork')),
    ADD CONSTRAINT ck_sessions_provenance_shape
        CHECK (
            (spawned_from_session_id IS NULL AND spawned_from_run_id IS NULL
                AND spawned_at IS NULL AND kind IS NULL)
            OR
            (spawned_from_session_id IS NOT NULL AND spawned_from_run_id IS NOT NULL
                AND spawned_at IS NOT NULL AND kind IS NOT NULL)
        );
