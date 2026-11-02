-- PLAN-0624 M0 (V93): wake-and-judge ground truth.
--
-- Contract sources (frozen, do not re-litigate here):
--   * PLAN-0624 README §范围 #1/#3/#6 + Q1–Q6 (`5dba6764` + Q6 追加): judge is fail-closed (Q2),
--     its cost is metered (Q1/Q6, governor MODEL key), SCHEDULE carries per-participant parameters
--     (Q4: jitter + concurrency ceiling), and "who triggered the run" is answerable (G-24).
--   * G-15 audit table `judge_decisions` — the four corrections approved by Lead 2026-11-02:
--     run_id nullable + ON DELETE SET NULL (audit outlives the run), trigger_source column
--     (trigger path must be recoverable even when run_id is null), prompt/completion tokens
--     split (cost-verification input), outcome + error (fail-closed silence must be visible).
--
-- Deliberately NOT here: TOOL stays out of the wake CHECK (0624 does not implement tool-triggered
-- wake); the judge executor (M1), the scheduler (M2), the wake chain (M3), the @-serial fan-out
-- (M4), any UI/CLI — and no query endpoint for judge_decisions (audit is write-only in 0624).
--
-- Reversible: DROP the table/columns/constraints created below; the trigger_source backfill is a
-- plain DEFAULT fill, recomputed the same way on re-migration.

-- ---------------------------------------------------------------------------
-- 1) wake_policy gains SCHEDULE; the schedule parameters live per participant in wake_config
--    (JSONB). NOT in agent_principals.context_policy (D23-20: that column is the context assembly
--    policy of the agent subject, and the 0624 boundary table forbids reusing it) and NOT in the
--    agent-runtime config domain (that is a global-default surface; a per-participant override has
--    no place there).
-- ---------------------------------------------------------------------------

ALTER TABLE session_participants ADD COLUMN wake_config JSONB;

-- Key contract for wake_config (M2 reads exactly this shape):
--   { "intervalSeconds": <int, required>, "jitterSeconds"?: <int>, "maxConcurrent"?: <int> }
--   jitterSeconds defaults to [0, interval*0.1) per Q4; maxConcurrent defaults to the governor JOB
--   ceiling. The CHECK only enforces "SCHEDULE requires wake_config"; the reverse (clearing the
--   config when the policy changes) is application-layer, to avoid fighting 0623 legacy rows.

ALTER TABLE session_participants DROP CONSTRAINT ck_session_participants_wake;
ALTER TABLE session_participants
    ADD CONSTRAINT ck_session_participants_wake
        CHECK (wake_policy IN ('ALL_MESSAGES', 'MENTION', 'SCHEDULE'));

ALTER TABLE session_participants
    ADD CONSTRAINT ck_session_participants_schedule_needs_config
        CHECK (wake_policy <> 'SCHEDULE' OR wake_config IS NOT NULL);

-- ---------------------------------------------------------------------------
-- 2) chat_runs.trigger_source — G-24 "who triggered this run".
--    Every pre-V93 run is a user-triggered run: the NOT NULL DEFAULT does the backfill in the same
--    statement (no separate UPDATE pass, no window where the column is wrong).
-- ---------------------------------------------------------------------------

ALTER TABLE chat_runs ADD COLUMN trigger_source TEXT NOT NULL DEFAULT 'user';

ALTER TABLE chat_runs
    ADD CONSTRAINT ck_chat_runs_trigger_source
        CHECK (trigger_source IN ('user', 'mention', 'schedule', 'judge', 'guard', 'chain'));

-- ---------------------------------------------------------------------------
-- 3) judge_decisions — the G-15 audit table. One row per judge invocation, INCLUDING failures:
--    PLAN-0624 Q2 is fail-closed (a failed or timed-out judge means "do not speak"), and a refusal
--    that leaves no row is undiagnosable. input_window stores the window description only (seq
--    ranges + summary reference + duty-template version) — never the raw messages (telemetry
--    hygiene). verdict is the judge's raw output (conclusion + reason + mentioned participant ids;
--    the mention extraction is a 0624 M4 consumer, schema reserved, content not validated here).
-- ---------------------------------------------------------------------------

CREATE TABLE judge_decisions (
    id                UUID        PRIMARY KEY,
    session_id        UUID        NOT NULL,
    run_id            UUID,
    participant_id    UUID        NOT NULL,
    trigger_source    TEXT        NOT NULL,
    input_window      TEXT        NOT NULL,
    verdict           JSONB       NOT NULL,
    model_provider    TEXT        NOT NULL,
    model_name        TEXT        NOT NULL,
    latency_ms        INTEGER     NOT NULL,
    prompt_tokens     BIGINT,
    completion_tokens BIGINT,
    outcome           TEXT        NOT NULL DEFAULT 'succeeded',
    error             TEXT,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- Audit outlives the participant: physical removal is refused (D23-26 soft-disables instead).
    CONSTRAINT fk_judge_decisions_participant FOREIGN KEY (participant_id)
        REFERENCES session_participants (id) ON DELETE RESTRICT,
    -- The context_events precedent: a deleted session takes its event/audit rows with it.
    CONSTRAINT fk_judge_decisions_session FOREIGN KEY (session_id)
        REFERENCES sessions (id) ON DELETE CASCADE,
    -- Audit outlives the run: deleting a run only clears the reference.
    CONSTRAINT fk_judge_decisions_run FOREIGN KEY (run_id)
        REFERENCES chat_runs (id) ON DELETE SET NULL,
    CONSTRAINT ck_judge_decisions_trigger CHECK (trigger_source IN
        ('user', 'mention', 'schedule', 'judge', 'guard', 'chain')),
    CONSTRAINT ck_judge_decisions_outcome CHECK (outcome IN
        ('succeeded', 'failed', 'timeout', 'throttled'))
);

-- Audit reads are by session/participant over time; never by run.
CREATE INDEX idx_judge_decisions_session_created
    ON judge_decisions (session_id, created_at DESC);
CREATE INDEX idx_judge_decisions_participant
    ON judge_decisions (participant_id);
