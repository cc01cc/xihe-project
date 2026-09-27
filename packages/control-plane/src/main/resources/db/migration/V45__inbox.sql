-- PLAN-0408 T1.1 (V45): derived collaboration Inbox — the durable child
-- terminal notice table. Frozen source: plans/PLAN-0408-XH-derived-collab-notify/
--   tasks.md T1.1 (7 columns + unique key + payload whitelist)
--   design.md #5/#13/#16, spec/derived-collab-notify.md §2,
--   spec/session/derived-collaboration-inbox.md
-- One transaction (Flyway on PostgreSQL): any failure rolls the whole file back.
-- No down migration by design (one-shot schema evolution).
--
-- Migration ownership: V42 = PLAN-0374, V43 = PLAN-0410, V44 = PLAN-0407,
-- V45 = PLAN-0408. Nothing here rebuilds V42/V43/V44 objects.
--
-- Parent deletion clears this Session's Inbox rows through the ON DELETE
-- CASCADE FK. Child Session/ChatRun appear only as plain UUID values (ref,
-- payload_pointer) — no FK, so a child is never created, deleted or cascaded
-- by this table, and deleting a parent never touches child rows.

CREATE TABLE inbox (
    id              UUID         PRIMARY KEY,
    to_session_id   UUID         NOT NULL,
    type            VARCHAR(64)  NOT NULL,
    ref             UUID         NOT NULL,
    payload_pointer JSONB        NOT NULL,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    injected_run_id UUID,
    -- parent Session only; ON DELETE CASCADE implements "parent delete clears
    -- its Inbox" inside the same delete transaction that locks the Session.
    CONSTRAINT fk_inbox_session
        FOREIGN KEY (to_session_id) REFERENCES sessions (id)
        ON DELETE CASCADE,
    -- frozen notification type: this table is not a general message platform.
    CONSTRAINT ck_inbox_type CHECK (type = 'child_terminal'),
    -- payload_pointer whitelist: a JSON object whose keys are a subset of
    -- {sessionId, runId, state}. No name/content/dataRef/free-form extension.
    CONSTRAINT ck_inbox_payload_pointer CHECK (
        jsonb_typeof(payload_pointer) = 'object'
        AND payload_pointer - 'sessionId' - 'runId' - 'state' = '{}'::jsonb
    ),
    -- at most one notice per (parent Session, type, child run): repeated or
    -- concurrent terminal CAS attempts cannot produce duplicate rows.
    CONSTRAINT uq_inbox_session_type_ref UNIQUE (to_session_id, type, ref)
);
