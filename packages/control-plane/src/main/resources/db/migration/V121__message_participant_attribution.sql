-- PLAN-0669 M1 (V121, Lead-assigned 2026-11-05): durable actor attribution for Messages.
--
-- Contract source: plans/PLAN-0669-xh-history-attribution/README.md (D1/D2) + review/round-01.md.
--   * D1: one column on the Message row. The actor is an immutable fact about who produced the
--     message, so it must not be derived from mutable Run/Session rows at read time ("run 行可变，
--     把历史归属绑在可变行上本身就是错的").
--   * D2: written once at ChatSubmissionService.persistAssistantResponse. Assistant rows carry the
--     run's responder participant; user rows keep NULL in v1 — the composer's `asParticipantId` is a
--     target identity (PRIMARY is an AGENT participant), not the author.
--   * No backfill: rows written before this migration have no knowable actor. NULL means "no
--     attribution" ⇒ the UI renders no badge (never "unknown", never a bare UUID — DEV-032).
--   * No index: the only read path is `findBySessionIdOrderByCreatedAtAsc` + per-row projection
--     (MessageReadService); there is no "messages by participant" query, so an index would have no
--     consumer.
--   * FK ON DELETE SET NULL: removing a participant leaves the history without attribution instead
--     of a dangling id or a blocked removal (PRIMARY is immutable by D23-13; MEMBER removal stays
--     legal). The read side then takes the same "no attribution" path as pre-V121 rows.
--
-- Reversible: DROP the constraint and the column; no data migration is involved.

ALTER TABLE messages ADD COLUMN participant_id UUID;

ALTER TABLE messages
    ADD CONSTRAINT fk_messages_participant
        FOREIGN KEY (participant_id) REFERENCES session_participants (id) ON DELETE SET NULL;
