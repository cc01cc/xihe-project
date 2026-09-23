-- PLAN-0407 T1.4: distinguish user submissions from CP-derived child runs.

ALTER TABLE chat_runs
    ADD COLUMN origin VARCHAR(24);

UPDATE chat_runs
SET origin = 'user_submission'
WHERE origin IS NULL;

ALTER TABLE chat_runs
    ALTER COLUMN origin SET NOT NULL,
    ADD CONSTRAINT ck_chat_runs_origin
        CHECK (origin IN ('user_submission', 'spawn'));

CREATE UNIQUE INDEX uq_chat_runs_spawn_event_idempotency
    ON chat_runs (user_id, idempotency_key)
    WHERE origin = 'spawn';
