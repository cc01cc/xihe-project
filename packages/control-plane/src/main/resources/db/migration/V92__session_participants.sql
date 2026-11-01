-- PLAN-0623 M0 (V92): session participants — the durable shape of "who is in this conversation".
--
-- Contract sources (frozen, do not re-litigate here):
--   * PLAN-0623 README §已裁定: R1 (run-level responder), R2 (polymorphic participant reference),
--     R3 (default policies), R4 (order_index), R7 (cursors are read-only in 0623), D23-20
--     (assembly policy belongs to the agent subject).
--   * plans/PLAN-0623-XH-session-participants/evidence/m3-design-predraft.md rev.4 §0.1/§2/§5.
--
-- D16 ordering (0622 lesson): add nullable columns first, then backfill, then constraints/indexes.
-- The only ordering-sensitive part here is the PRIMARY partial unique index: it is created AFTER
-- the legacy backfill, so a pre-existing primary row can never collide with the backfill itself.
--
-- Deliberately NOT in this migration:
--   * session_participants.cap_snapshot — a Lead ruling (2026-11-02) removed it: 0622 collapsed the
--     cap into resolveCapFor(principalId, workspaceId), so a participant-level snapshot would be a
--     second source of truth. The migration test asserts the column is absent on purpose.
--   * sessions.agent_principal_id removal — deferred to M1 (R6 read paths).
--   * chat_runs.context_snapshot_seq — no consumer yet (PLAN-0622 R8 lesson), deferred to M1.
--   * agent_principals.context_policy stays OUT of the `context-policy` config domain (D23-20):
--     it is a column on the subject, not a config key, so the instance/user/workspace layering is
--     untouched.
--
-- Reversible: DROP the three tables/columns and the indexes created below; the legacy
-- sessions.agent_principal_id column is untouched, so the backfill can be recomputed.

-- ---------------------------------------------------------------------------
-- 1) D23-20: assembly policy on the agent subject (nullable, no default)
-- ---------------------------------------------------------------------------

ALTER TABLE agent_principals ADD COLUMN context_policy JSONB;

-- ---------------------------------------------------------------------------
-- 2) R1: the run's responder (legacy runs keep NULL — the migration invents nothing)
-- ---------------------------------------------------------------------------

ALTER TABLE chat_runs ADD COLUMN agent_principal_id UUID;

ALTER TABLE chat_runs
    ADD CONSTRAINT fk_chat_runs_agent_principal
        FOREIGN KEY (agent_principal_id) REFERENCES agent_principals (id) ON DELETE RESTRICT;

CREATE INDEX idx_chat_runs_agent_principal_id ON chat_runs (agent_principal_id)
    WHERE agent_principal_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 3) R2/R3/R4: participants. Polymorphic (principal_kind, principal_id) with NO FK on that side —
--    the role_bindings(subject_type, subject_id) precedent (V87). principal_kind is the discriminator.
-- ---------------------------------------------------------------------------

CREATE TABLE session_participants (
    id              UUID        PRIMARY KEY,
    session_id      UUID        NOT NULL,
    principal_kind  TEXT        NOT NULL,
    principal_id    UUID        NOT NULL,
    role            TEXT        NOT NULL,
    order_index     INTEGER     NOT NULL,
    wake_policy     TEXT        NOT NULL DEFAULT 'MENTION',
    respond_policy  TEXT        NOT NULL DEFAULT 'WHEN_MENTIONED',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    disabled_at     TIMESTAMPTZ,
    CONSTRAINT fk_session_participants_session FOREIGN KEY (session_id)
        REFERENCES sessions (id) ON DELETE CASCADE,
    CONSTRAINT ck_session_participants_kind CHECK (principal_kind IN ('HUMAN', 'AGENT')),
    -- D23-02: PRIMARY/MEMBER/GUARD. Never OWNER — that word is a workspace role and would mix
    -- two different authorization planes.
    CONSTRAINT ck_session_participants_role CHECK (role IN ('PRIMARY', 'MEMBER', 'GUARD')),
    -- D23-04: 0623 wakes on every message or on a mention; SCHEDULE belongs to 0624.
    CONSTRAINT ck_session_participants_wake CHECK (wake_policy IN ('ALL_MESSAGES', 'MENTION')),
    -- D23-05: JUDGE is a reserved enum (implemented in 0624), MUTED is the 0623 mute switch.
    CONSTRAINT ck_session_participants_respond
        CHECK (respond_policy IN ('ALWAYS', 'WHEN_MENTIONED', 'JUDGE', 'MUTED'))
);

-- Legacy backfill BEFORE the unique indexes: one PRIMARY per session that already had a responder.
-- R3 defaults from the §8 appendix: PRIMARY(AGENT) wakes on every message and answers ALWAYS.
-- R4: the first participant takes the initial step (10, step 10 — room for 0624 "insert in the middle").
-- Sessions without an agent_principal_id stay empty: the migration never invents a responder.
INSERT INTO session_participants (id, session_id, principal_kind, principal_id, role, order_index,
                                  wake_policy, respond_policy)
SELECT gen_random_uuid(), s.id, 'AGENT', s.agent_principal_id, 'PRIMARY', 10,
       'ALL_MESSAGES', 'ALWAYS'
FROM sessions s
WHERE s.agent_principal_id IS NOT NULL
  AND NOT EXISTS (
      SELECT 1 FROM session_participants p
      WHERE p.session_id = s.id AND p.role = 'PRIMARY'
  );

-- Uniqueness: one row per (session, principal), one row per order step, exactly one PRIMARY.
CREATE UNIQUE INDEX uq_session_participants_principal
    ON session_participants (session_id, principal_kind, principal_id);
CREATE UNIQUE INDEX uq_session_participants_order
    ON session_participants (session_id, order_index);
-- D23-13: PRIMARY is unique, cannot be removed or transferred; the database refuses a second one.
CREATE UNIQUE INDEX uq_session_participants_primary
    ON session_participants (session_id) WHERE role = 'PRIMARY';

CREATE INDEX idx_session_participants_session ON session_participants (session_id, order_index);
CREATE INDEX idx_session_participants_principal ON session_participants (principal_kind, principal_id);

-- ---------------------------------------------------------------------------
-- 4) R7: read cursors. 0623 reads them only; the server advances them off the event stream and the
--    client-side reporting lands in 0624 (with notifications). A pointer (not a counter) so the count
--    can always be recomputed from context_events, the same shape as the event sequence itself.
-- ---------------------------------------------------------------------------

CREATE TABLE session_participant_cursors (
    participant_id      UUID        PRIMARY KEY,
    last_read_event_seq BIGINT      NOT NULL DEFAULT 0,
    mention_count       INTEGER     NOT NULL DEFAULT 0,
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT fk_session_participant_cursors_participant FOREIGN KEY (participant_id)
        REFERENCES session_participants (id) ON DELETE CASCADE
);

-- Backfill for the rows created above: history counts as read. A session with no events starts at 0.
INSERT INTO session_participant_cursors (participant_id, last_read_event_seq, mention_count)
SELECT p.id,
       COALESCE((SELECT MAX(e.sequence) FROM context_events e WHERE e.session_id = p.session_id), 0),
       0
FROM session_participants p
WHERE NOT EXISTS (
    SELECT 1 FROM session_participant_cursors c WHERE c.participant_id = p.id
);
