-- PLAN-0442: CP-owned durable FIFO for user Follow-up requests.
-- No historical backfill: existing Sessions start with an empty queue.

CREATE TABLE session_follow_up_items (
    id UUID NOT NULL,
    session_id UUID NOT NULL,
    queue_sequence BIGINT NOT NULL,
    idempotency_key VARCHAR(128) NOT NULL,
    request_hash VARCHAR(64) NOT NULL,
    content TEXT,
    attachment_refs JSONB NOT NULL DEFAULT '[]'::jsonb,
    branch_id UUID NOT NULL,
    tool_mode VARCHAR(20) NOT NULL DEFAULT 'none',
    tool_timeouts JSONB NOT NULL DEFAULT '{}'::jsonb,
    provider VARCHAR(50),
    model VARCHAR(100),
    status VARCHAR(16) NOT NULL DEFAULT 'queued',
    pause_reason VARCHAR(64),
    anchor_run_id UUID,
    pause_run_id UUID,
    child_run_id UUID,
    child_message_id UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    admitted_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    withdrawn_at TIMESTAMPTZ,
    CONSTRAINT pk_session_follow_up_items PRIMARY KEY (id),
    CONSTRAINT fk_session_follow_up_items_session
        FOREIGN KEY (session_id) REFERENCES sessions (id) ON DELETE CASCADE,
    CONSTRAINT fk_session_follow_up_items_anchor_run
        FOREIGN KEY (anchor_run_id) REFERENCES chat_runs (id) ON DELETE SET NULL,
    CONSTRAINT fk_session_follow_up_items_pause_run
        FOREIGN KEY (pause_run_id) REFERENCES chat_runs (id) ON DELETE SET NULL,
    CONSTRAINT fk_session_follow_up_items_child_run
        FOREIGN KEY (child_run_id) REFERENCES chat_runs (id) ON DELETE SET NULL,
    CONSTRAINT fk_session_follow_up_items_child_message
        FOREIGN KEY (child_message_id) REFERENCES messages (id) ON DELETE SET NULL,
    CONSTRAINT uq_session_follow_up_items_session_sequence UNIQUE (session_id, queue_sequence),
    CONSTRAINT uq_session_follow_up_items_session_idempotency UNIQUE (session_id, idempotency_key),
    CONSTRAINT ck_session_follow_up_items_queue_sequence CHECK (queue_sequence > 0),
    CONSTRAINT ck_session_follow_up_items_status
        CHECK (status IN ('queued', 'paused', 'admitted', 'completed', 'withdrawn')),
    CONSTRAINT ck_session_follow_up_items_tool_mode
        CHECK (tool_mode IN ('none', 'workspace')),
    CONSTRAINT ck_session_follow_up_items_attachment_refs_array
        CHECK (jsonb_typeof(attachment_refs) = 'array'),
    CONSTRAINT ck_session_follow_up_items_tool_timeouts_object
        CHECK (jsonb_typeof(tool_timeouts) = 'object'),
    CONSTRAINT ck_session_follow_up_items_provider_model_pair
        CHECK ((provider IS NULL) = (model IS NULL))
);

CREATE UNIQUE INDEX uq_session_follow_up_items_child_run_id
    ON session_follow_up_items (child_run_id)
    WHERE child_run_id IS NOT NULL;

CREATE INDEX idx_session_follow_up_items_session_active_sequence
    ON session_follow_up_items (session_id, queue_sequence)
    WHERE status IN ('queued', 'paused', 'admitted');

COMMENT ON TABLE session_follow_up_items IS
    'CP-owned durable FIFO of user Follow-up request payloads before ChatRun admission';
COMMENT ON COLUMN session_follow_up_items.branch_id IS
    'Logical branch reference fixed at enqueue; admission revalidates visibility/existence and pauses instead of switching branches';
COMMENT ON COLUMN session_follow_up_items.attachment_refs IS
    'JSON array of File UUID strings; admission revalidates ownership and links each File to the child user Message';
COMMENT ON COLUMN session_follow_up_items.status IS
    'Queue state owned by FollowUpQueueService; ChatRun status remains execution source after admission';
