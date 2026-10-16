-- PLAN-0510 (V70): persist controlled continuation provenance on the child ChatRun.
-- The Run remains user-submitted; these nullable fields distinguish its
-- checkpoint-based continuation from an ordinary user message.
-- Rollback: ALTER TABLE chat_runs DROP CONSTRAINT fk_chat_runs_continuation_lineage,
-- fk_chat_runs_continuation_source, ck_chat_runs_continuation_provenance;
-- DROP INDEX idx_chat_runs_continuation_source;
-- ALTER TABLE chat_runs DROP COLUMN continuation_source_run_id,
-- continuation_lineage_id, continuation_thread_id, continuation_checkpoint_id,
-- continuation_event_sequence, continuation_mode.

ALTER TABLE chat_runs
    ADD COLUMN continuation_source_run_id UUID,
    ADD COLUMN continuation_lineage_id UUID,
    ADD COLUMN continuation_thread_id UUID,
    ADD COLUMN continuation_checkpoint_id VARCHAR(128),
    ADD COLUMN continuation_event_sequence BIGINT,
    ADD COLUMN continuation_mode VARCHAR(32);

ALTER TABLE chat_runs
    ADD CONSTRAINT ck_chat_runs_continuation_provenance
        CHECK (
            (continuation_source_run_id IS NULL
                AND continuation_lineage_id IS NULL
                AND continuation_thread_id IS NULL
                AND continuation_checkpoint_id IS NULL
                AND continuation_event_sequence IS NULL
                AND continuation_mode IS NULL)
            OR
            (continuation_source_run_id IS NOT NULL
                AND continuation_lineage_id IS NOT NULL
                AND continuation_thread_id IS NOT NULL
                AND continuation_checkpoint_id IS NOT NULL
                AND length(btrim(continuation_checkpoint_id)) > 0
                AND continuation_event_sequence IS NOT NULL
                AND continuation_event_sequence >= 0
                AND continuation_mode IS NOT NULL
                AND continuation_mode IN ('resume_pending', 'append_user_turn'))
        ),
    ADD CONSTRAINT fk_chat_runs_continuation_source
        FOREIGN KEY (session_id, continuation_source_run_id, branch_id)
        REFERENCES chat_runs (session_id, id, branch_id) ON DELETE CASCADE,
    ADD CONSTRAINT fk_chat_runs_continuation_lineage
        FOREIGN KEY (continuation_lineage_id, continuation_thread_id)
        REFERENCES agent_graph_checkpoint_lineages (lineage_id, thread_id) ON DELETE CASCADE;

CREATE INDEX idx_chat_runs_continuation_source
    ON chat_runs (continuation_source_run_id)
    WHERE continuation_source_run_id IS NOT NULL;
