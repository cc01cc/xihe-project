-- PLAN-0508 T2.1: one lifecycle row per provider HTTP attempt.
--
-- The row starts as status=running, then reaches one terminal outcome. Run
-- terminal reconciliation changes any remaining running row to partial.
-- session_id is a denormalized logical copy for Session aggregation; run_id is
-- the lifecycle FK and its cascade owns deletion, so no second session FK.
-- Provider/model/connection identity is projected from the immutable ChatRun
-- snapshot and is not duplicated on every attempt row.
-- last_progress_sample (B1 minimal): while the row is running, the last
-- accepted bounded stage sample updates in strict stage order, at most four
-- transitions per attempt; updated_at doubles as the CP receipt time.
--
-- Rollback (development only, before retained attempt data is needed):
-- DROP TABLE chat_run_transport_attempts;

CREATE TABLE chat_run_transport_attempts (
    attempt_id            UUID         PRIMARY KEY,
    run_id                UUID         NOT NULL REFERENCES chat_runs (id) ON DELETE CASCADE,
    session_id            UUID         NOT NULL,
    seq                   BIGINT       NOT NULL,
    status                VARCHAR(16)  NOT NULL,
    outcome               VARCHAR(16),
    started_at            TIMESTAMPTZ  NOT NULL,
    ended_at              TIMESTAMPTZ,
    duration_ms           BIGINT,
    error_code            VARCHAR(64),
    provider_http_status  INTEGER,
    first_chunk_ms        BIGINT,
    chunk_count           BIGINT,
    last_progress_stage   VARCHAR(32),
    last_progress_elapsed_ms BIGINT,
    created_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_chat_run_transport_attempts_run_seq UNIQUE (run_id, seq),
    CONSTRAINT ck_chat_run_transport_attempts_seq CHECK (seq >= 1),
    CONSTRAINT ck_chat_run_transport_attempts_status CHECK (status IN ('running', 'terminal')),
    CONSTRAINT ck_chat_run_transport_attempts_outcome CHECK (
        outcome IS NULL OR outcome IN ('success', 'error', 'timeout', 'aborted', 'partial')),
    CONSTRAINT ck_chat_run_transport_attempts_lifecycle CHECK (
        (status = 'running' AND outcome IS NULL AND ended_at IS NULL)
        OR (status = 'terminal' AND outcome IS NOT NULL AND ended_at IS NOT NULL)),
    CONSTRAINT ck_chat_run_transport_attempts_nonnegative_metrics CHECK (
        (duration_ms IS NULL OR duration_ms >= 0)
        AND (first_chunk_ms IS NULL OR first_chunk_ms >= 0)
        AND (chunk_count IS NULL OR chunk_count >= 0)),
    CONSTRAINT ck_chat_run_transport_attempts_error_source CHECK (
        error_code IS NULL OR provider_http_status IS NULL),
    CONSTRAINT ck_chat_run_transport_attempts_progress_stage CHECK (
        last_progress_stage IS NULL OR last_progress_stage IN (
            'attempt_started', 'first_chunk', 'streaming', 'attempt_finished')),
    CONSTRAINT ck_chat_run_transport_attempts_progress_pair CHECK (
        (last_progress_stage IS NULL AND last_progress_elapsed_ms IS NULL)
        OR (last_progress_stage IS NOT NULL AND last_progress_elapsed_ms IS NOT NULL)),
    CONSTRAINT ck_chat_run_transport_attempts_progress_elapsed CHECK (
        last_progress_elapsed_ms IS NULL OR last_progress_elapsed_ms >= 0)
);

CREATE INDEX idx_chat_run_transport_attempts_session_id
    ON chat_run_transport_attempts (session_id);

CREATE INDEX idx_chat_run_transport_attempts_running_run
    ON chat_run_transport_attempts (run_id)
    WHERE status = 'running';
