-- PLAN-0660 M5-B / T5.8 (V128): user_questions — the durable shape of "the agent is waiting for
-- an answer".
--
-- Contract sources (frozen, do not re-litigate here):
--   * PLAN-0648 design.md §6 "数据模型（最小集）" — the column / constraint / index list below is a
--     1:1 reconstruction of that frozen table (PLAN-0648 merged into PLAN-0660 by D66-12).
--   * The same list is rebuilt for cross-checking in spec/session/user-channel.md §6, per T5.8: the
--     checklist must be readable from the active SPEC, not only from an archived plan's section
--     number.
--   * Invariants: spec/session/user-channel.md §5 (visibility, no existence leakage, no question
--     bodies in logs / audit / problem detail) and PLAN-0648 design.md §4 (at most one pending human
--     interaction per run; terminal states never roll back).
--
-- Numbering: this repo keeps flyway `outOfOrder=false` and never pre-allocates a number. V128 was
-- taken at implementation time as max(V127) + 1, after checking (a) develop, (b) every active
-- worktree under .worktrees/, (c) the dev database's flyway_schema_history (watermark = 127).
--
-- Deliberate choices, recorded for the reviewer:
--   * No workspace_id column: since PLAN-0647 a session may legitimately have no workspace, and the
--     workspace is one join away through sessions — a denormalised copy would be a second source of
--     truth (same reasoning as approval_requests keeping what it needs only).
--   * prompt / answer carry no index of any kind (no trigram, no full text): the question body is
--     untrusted text that must never become a searchable column, and it must never be written to
--     logs, audit rows or problem detail (spec §5.2). Only the questionId and its length may leave CP.
--   * "At most one pending human interaction per run" contradicts approval_requests across two
--     tables, so no constraint here can express it. That half stays a service-level CAS + 409
--     (PLAN-0648 design.md decision #12) and is asserted by PLAN-0660 T5.9/T5.13. What the database
--     CAN enforce — one pending question per run — is the partial unique index at the bottom.
--   * The v1 prompt limit (write side, <= 2000 chars) is deliberately NOT a CHECK: the frozen model
--     puts it on the writer, and the schema must not become the place where answerability is decided.
--   * asked_by_participant_id gets no dedicated index (the body is small and both read paths start at
--     addressee_user_id or session_id); revisit if participant deletion ever shows a seq scan on the
--     ON DELETE SET NULL path (V31 precedent).
--
-- Reversible: DROP TABLE user_questions;  (no other object touched — all three indexes and four FKs
-- are owned by the table)

CREATE TABLE user_questions (
    id                      UUID        PRIMARY KEY,
    -- launch context; workspace is reachable through sessions (see header)
    session_id              UUID        NOT NULL,
    -- the run that is waiting; same shape as approval_requests.run_id (V1:409)
    run_id                  UUID        NOT NULL,
    -- the agent participant that asked on the run's behalf; NULL when the caller has none
    asked_by_participant_id UUID,
    -- the only principal allowed to answer
    addressee_user_id       UUID        NOT NULL,
    -- untrusted text; never indexed, never logged (spec §5)
    prompt                  TEXT        NOT NULL,
    state                   TEXT        NOT NULL,
    -- NULL = ask (blocking wait, the deadline is owned by the Agent); non-null = askTimed deadline
    expires_at              TIMESTAMPTZ,
    answer                  TEXT,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- three separate stamps: asked / delivered (hint handed to the user channel) / settled
    first_delivered_at      TIMESTAMPTZ,
    settled_at              TIMESTAMPTZ,
    CONSTRAINT fk_user_questions_session FOREIGN KEY (session_id)
        REFERENCES sessions (id) ON DELETE CASCADE,
    CONSTRAINT fk_user_questions_run FOREIGN KEY (run_id)
        REFERENCES chat_runs (id) ON DELETE CASCADE,
    CONSTRAINT fk_user_questions_asked_by_participant FOREIGN KEY (asked_by_participant_id)
        REFERENCES session_participants (id) ON DELETE SET NULL,
    -- users are soft-deleted (V86); the default NO ACTION keeps a hard delete from silently dropping
    -- a question somebody was still owed. Same shape as fk_approval_requests_user (V1).
    CONSTRAINT fk_user_questions_addressee FOREIGN KEY (addressee_user_id)
        REFERENCES users (id),
    CONSTRAINT ck_user_questions_state
        CHECK (state IN ('pending', 'answered', 'expired', 'cancelled'))
);

-- Projection main query: pending questions of one addressee, newest first
-- (GET /api/v1/user-questions?state=pending).
CREATE INDEX idx_user_questions_addressee_pending
    ON user_questions (addressee_user_id, created_at DESC)
    WHERE state = 'pending';

-- Session-scoped read face: visible session readers get the projection without being the addressee.
CREATE INDEX idx_user_questions_session_created
    ON user_questions (session_id, created_at);

-- At most one unresolved question per run. The cross-table half of "one human interaction at a
-- time" stays in the service layer; this is the part the database can own.
CREATE UNIQUE INDEX uq_user_questions_run_pending
    ON user_questions (run_id)
    WHERE state = 'pending';
