-- PLAN-0407 T1.1: single-parent session provenance for spawn/fork.
--
-- Keep the references nullable for existing sessions. `kind` is added in the
-- later lifecycle milestone (T2.7); this migration only establishes the three
-- provenance columns frozen for V37.

ALTER TABLE sessions
    ADD COLUMN spawned_from_session_id UUID,
    ADD COLUMN spawned_from_run_id UUID,
    ADD COLUMN spawned_at TIMESTAMPTZ;

CREATE INDEX idx_sessions_spawned_from_session
    ON sessions (spawned_from_session_id)
    WHERE spawned_from_session_id IS NOT NULL;

CREATE INDEX idx_sessions_spawned_from_run
    ON sessions (spawned_from_run_id)
    WHERE spawned_from_run_id IS NOT NULL;
