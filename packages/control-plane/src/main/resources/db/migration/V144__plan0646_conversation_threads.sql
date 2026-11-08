-- PLAN-0646 MVP (D-671, 2026-11-08): communication scope triple + conversation thread minimal shape.
--
-- Why a thread table and not a session column pair: thread must outlive one session (1 thread : N sessions)
-- and carry ONE scope for the whole line. Only the thread stores (scope_type, scope_id); messages keep
-- their session FK, so the send path has no new column and 21 existing channels stay untouched.
--
-- MVP scope (D-671): scope_type CHECK admits the full three values user|agent|workspace, but the
-- service only resolves user|agent; workspace reads/writes fail closed (V4 deferred).
-- sessions.conversation_thread_id stays NULLABLE: existing sessions keep today's behaviour (V1/V6);
-- the clean-slate NOT NULL + ON DELETE RESTRICT variant is superseded for this MVP.
--
-- Rollback: ALTER TABLE sessions DROP CONSTRAINT fk_sessions_conversation_thread, DROP COLUMN
-- conversation_thread_id; DROP TABLE conversation_threads;

CREATE TABLE conversation_threads (
    id                  UUID         PRIMARY KEY,
    scope_type          VARCHAR(16)  NOT NULL CHECK (scope_type IN ('user', 'agent', 'workspace')),
    scope_id            UUID         NOT NULL,
    created_by_user_id  UUID         NOT NULL,
    title               VARCHAR(255),
    created_at          TIMESTAMPTZ  NOT NULL,
    updated_at          TIMESTAMPTZ  NOT NULL,
    CONSTRAINT fk_conversation_threads_created_by
        FOREIGN KEY (created_by_user_id) REFERENCES users (id) ON DELETE RESTRICT
);

CREATE INDEX idx_conversation_threads_scope_updated
    ON conversation_threads (scope_type, scope_id, updated_at DESC, id);

ALTER TABLE sessions ADD COLUMN conversation_thread_id UUID;

ALTER TABLE sessions
    ADD CONSTRAINT fk_sessions_conversation_thread
    FOREIGN KEY (conversation_thread_id) REFERENCES conversation_threads (id) ON DELETE SET NULL;

CREATE INDEX idx_sessions_conversation_thread
    ON sessions (conversation_thread_id) WHERE conversation_thread_id IS NOT NULL;

COMMENT ON TABLE conversation_threads IS
    'PLAN-0646 MVP: one communication line; scope_type in user|agent|workspace, scope_id polymorphic (no FK).';
COMMENT ON COLUMN sessions.conversation_thread_id IS
    'PLAN-0646 MVP: the thread this session belongs to (nullable; existing sessions stay unchanged).';
