-- PLAN-0410 T1.1: Session branch context isolation (V43).
-- Frozen source: plans/PLAN-0410-XH-session-branch-context-isolation/spec/field-matrix.md §1/§2
--                + spec/branch-aware-context.md §1/§6/§7.
-- One transaction (Flyway on PostgreSQL): any failure rolls the whole file back.
-- No down migration by design (one-shot schema evolution, PLAN-0410 T1.1).
--
-- Ordering note: EVERY DDL statement on session_branches runs before its first
-- DML. fk_session_branches_session is DEFERRABLE (root bootstrap may execute
-- before the referencing Session INSERT inside one runtime transaction), and
-- PostgreSQL rejects ALTER TABLE on a table with pending deferred trigger
-- events — so all constraints land before the backfill INSERT.

-- ---------------------------------------------------------------------------
-- 1. session_branches (new table) — all DDL on this table happens here
-- ---------------------------------------------------------------------------
CREATE TABLE session_branches (
    id                     UUID         PRIMARY KEY,
    session_id             UUID         NOT NULL,
    parent_branch_id       UUID,
    fork_point_message_id  UUID,
    fork_point_run_id      UUID,
    fork_point_sequence    BIGINT,
    idempotency_key        VARCHAR(128),
    request_hash           VARCHAR(64),
    created_at             TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    -- Session deletion removes this Session's branch rows; fork/child Sessions
    -- are separate rows with their own session_id and are never cascaded.
    -- DEFERRABLE: root-branch bootstrap may run in the same transaction before
    -- the referencing Session INSERT is flushed (spawn/import flows persist
    -- Session + Message/ChatRun without an intervening flush); the check is
    -- enforced at commit either way.
    CONSTRAINT fk_session_branches_session
        FOREIGN KEY (session_id) REFERENCES sessions (id)
        ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
    -- root/child field groups (field-matrix §1): root rows carry no anchor or
    -- idempotency; child rows carry anchor + request idempotency completely.
    CONSTRAINT ck_session_branches_root_fields CHECK (
        parent_branch_id IS NOT NULL
        OR (fork_point_message_id IS NULL AND fork_point_run_id IS NULL
            AND fork_point_sequence IS NULL
            AND idempotency_key IS NULL AND request_hash IS NULL)
    ),
    CONSTRAINT ck_session_branches_child_fields CHECK (
        parent_branch_id IS NULL
        OR (fork_point_message_id IS NOT NULL AND fork_point_run_id IS NOT NULL
            AND fork_point_sequence IS NOT NULL
            AND idempotency_key IS NOT NULL AND request_hash IS NOT NULL)
    ),
    CONSTRAINT uq_session_branches_session_id_id UNIQUE (session_id, id)
);

-- Exactly one root Branch per Session (parent IS NULL), and idempotent branch
-- creation is scoped per Session (field-matrix §1 partial uniques).
CREATE UNIQUE INDEX uq_session_branches_root
    ON session_branches (session_id) WHERE parent_branch_id IS NULL;
CREATE UNIQUE INDEX uq_session_branches_request_idempotency
    ON session_branches (session_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL;

-- Same-Session parent link; deleting a branch removes its descendants.
ALTER TABLE session_branches
    ADD CONSTRAINT fk_session_branches_parent
        FOREIGN KEY (session_id, parent_branch_id)
        REFERENCES session_branches (session_id, id)
        ON DELETE CASCADE;

-- ---------------------------------------------------------------------------
-- 2. branch_id columns (backfilled later) + anchor reference uniques
-- ---------------------------------------------------------------------------
ALTER TABLE messages ADD COLUMN branch_id UUID;

-- Anchor reference target for the composite fork-point FK below.
ALTER TABLE messages
    ADD CONSTRAINT uq_messages_session_id_id_branch_run UNIQUE (session_id, id, branch_id, run_id);

ALTER TABLE chat_runs ADD COLUMN branch_id UUID;

-- Anchor reference target for the composite fork-point Run FK below.
ALTER TABLE chat_runs
    ADD CONSTRAINT uq_chat_runs_session_id_branch UNIQUE (session_id, id, branch_id);

-- ---------------------------------------------------------------------------
-- 3. anchor composite FKs (spec §1/§6): a child Branch's anchor message/run
--    must belong to its parent branch inside the same Session. Column order
--    mirrors the target unique keys positionally. Root rows keep all anchor
--    columns NULL, so the check is skipped for them (MATCH SIMPLE).
-- ---------------------------------------------------------------------------
ALTER TABLE session_branches
    ADD CONSTRAINT fk_session_branches_anchor_message
        FOREIGN KEY (session_id, fork_point_message_id, parent_branch_id, fork_point_run_id)
        REFERENCES messages (session_id, id, branch_id, run_id)
        ON DELETE RESTRICT;

ALTER TABLE session_branches
    ADD CONSTRAINT fk_session_branches_anchor_run
        FOREIGN KEY (session_id, fork_point_run_id, parent_branch_id)
        REFERENCES chat_runs (session_id, id, branch_id)
        ON DELETE RESTRICT;

-- ---------------------------------------------------------------------------
-- 4. backfill: one root Branch for every existing Session
--    (first DML on session_branches — after ALL DDL on it)
-- ---------------------------------------------------------------------------
INSERT INTO session_branches (id, session_id, created_at)
SELECT gen_random_uuid(), s.id, NOW()
FROM sessions s;

-- ---------------------------------------------------------------------------
-- 5. messages: backfill root -> NOT NULL -> branch FK + index
-- ---------------------------------------------------------------------------
UPDATE messages m
SET branch_id = b.id
FROM session_branches b
WHERE b.session_id = m.session_id
  AND b.parent_branch_id IS NULL;

ALTER TABLE messages ALTER COLUMN branch_id SET NOT NULL;

ALTER TABLE messages
    ADD CONSTRAINT fk_messages_session_branch
        FOREIGN KEY (session_id, branch_id)
        REFERENCES session_branches (session_id, id)
        ON DELETE CASCADE;

CREATE INDEX idx_messages_session_branch_run
    ON messages (session_id, branch_id, run_id);

-- ---------------------------------------------------------------------------
-- 6. chat_runs: backfill root -> NOT NULL -> branch FK
-- ---------------------------------------------------------------------------
UPDATE chat_runs c
SET branch_id = b.id
FROM session_branches b
WHERE b.session_id = c.session_id
  AND b.parent_branch_id IS NULL;

ALTER TABLE chat_runs ALTER COLUMN branch_id SET NOT NULL;

ALTER TABLE chat_runs
    ADD CONSTRAINT fk_chat_runs_session_branch
        FOREIGN KEY (session_id, branch_id)
        REFERENCES session_branches (session_id, id)
        ON DELETE CASCADE;

-- ---------------------------------------------------------------------------
-- 7. context_events.branch_id (nullable) + matrix indexes + branch FK
--    Global Session facts keep correlation_id/branch_id both NULL.
-- ---------------------------------------------------------------------------
ALTER TABLE context_events ADD COLUMN branch_id UUID;

-- Double-verification backfill (field-matrix §1 / spec §7): only rows whose
-- payload runId resolves to a ChatRun of the SAME Session get correlation_id
-- backfilled; they land on the Session root baseline.
UPDATE context_events ce
SET correlation_id = ce.payload ->> 'runId',
    branch_id      = b.id
FROM session_branches b
WHERE b.session_id = ce.session_id
  AND b.parent_branch_id IS NULL
  AND ce.correlation_id IS NULL
  AND jsonb_typeof(ce.payload) = 'object'
  AND ce.payload ->> 'runId' IS NOT NULL
  AND EXISTS (
      SELECT 1
      FROM chat_runs cr
      WHERE cr.session_id = ce.session_id
        AND lower(cr.id::text) = lower(ce.payload ->> 'runId')
  );

-- Every other non-global legacy row stays on the root baseline with its
-- correlation untouched (cannot be trusted as a fork cursor).
UPDATE context_events ce
SET branch_id = b.id
FROM session_branches b
WHERE b.session_id = ce.session_id
  AND b.parent_branch_id IS NULL
  AND ce.event_type NOT IN (
      'session.created', 'context.source_changed', 'context.env_updated',
      'epoch.started', 'epoch.replaced', 'session.forked'
  );

CREATE INDEX idx_context_events_session_branch_sequence
    ON context_events (session_id, branch_id, sequence);
CREATE INDEX idx_context_events_session_correlation
    ON context_events (session_id, correlation_id, sequence);

ALTER TABLE context_events
    ADD CONSTRAINT fk_context_events_session_branch
        FOREIGN KEY (session_id, branch_id)
        REFERENCES session_branches (session_id, id)
        ON DELETE CASCADE;

-- ---------------------------------------------------------------------------
-- 8. context_projections: backfill root -> new unique -> DROP old unique last
--    (spec/branch-aware-context.md §6 step 4; field-matrix §2 #7)
-- ---------------------------------------------------------------------------
ALTER TABLE context_projections ADD COLUMN branch_id UUID;

UPDATE context_projections p
SET branch_id = b.id
FROM session_branches b
WHERE b.session_id = p.session_id
  AND b.parent_branch_id IS NULL;

ALTER TABLE context_projections ALTER COLUMN branch_id SET NOT NULL;

ALTER TABLE context_projections
    ADD CONSTRAINT uq_context_projections_session_type_branch
        UNIQUE (session_id, projection_type, branch_id);

-- Last: the V1 UNIQUE (session_id) would otherwise reject the second
-- projection row of one Session (spec §6 step 4).
ALTER TABLE context_projections DROP CONSTRAINT uq_context_projections_session;

ALTER TABLE context_projections
    ADD CONSTRAINT fk_context_projections_session_branch
        FOREIGN KEY (session_id, branch_id)
        REFERENCES session_branches (session_id, id)
        ON DELETE CASCADE;

-- ---------------------------------------------------------------------------
-- 9. backfill accounting (fail the migration rather than ship orphans)
-- ---------------------------------------------------------------------------
DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM sessions s
        WHERE NOT EXISTS (
            SELECT 1 FROM session_branches b
            WHERE b.session_id = s.id AND b.parent_branch_id IS NULL
        )
    ) THEN
        RAISE EXCEPTION 'V43 could not backfill a root branch for every Session';
    END IF;

    IF EXISTS (SELECT 1 FROM messages WHERE branch_id IS NULL)
        OR EXISTS (SELECT 1 FROM chat_runs WHERE branch_id IS NULL)
        OR EXISTS (SELECT 1 FROM context_projections WHERE branch_id IS NULL) THEN
        RAISE EXCEPTION 'V43 left NULL branch_id rows after backfill';
    END IF;
END
$$;
