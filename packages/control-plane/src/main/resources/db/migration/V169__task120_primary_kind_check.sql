-- task-120 (source: cp-1 task-116 §B / task-117 §E6): the PRIMARY participant row must be an AGENT.
--
-- Why this is a DATA constraint and not only a runtime guard: "PRIMARY is always an AGENT" is a data
-- invariant of session_participants today, but the DB never said so. V92 checks principal_kind
-- (V92:63) and role (V92:66) INDEPENDENTLY, so the pair ('HUMAN', 'PRIMARY') is legal to PostgreSQL
-- even though no application path can write it: ensurePrimaryParticipant hardcodes the AGENT kind
-- (SessionParticipantService:328-342) and both add (SPS:278-282) and update (SPS:354-362) refuse
-- role=PRIMARY. The writers are safe; the DATA is unguarded, so a manual edit, an import or a
-- cross-environment copy can still produce such a row.
--
-- What a HUMAN PRIMARY breaks: a default submission (no explicit asParticipantId) resolves its
-- responder through responderFor(sessionId, null) = the PRIMARY row, and a HUMAN responder makes
-- ChatSubmissionService store agent_principal_id = NULL (the V92 FK can never hold a user id). The
-- dispatch chain then has no definition: ChatController:1829 resolveSystemInstructionsForRun(null)
-- throws 400 INVALID_AGENT_PRINCIPAL (AgentPrincipalService:1843-1847) before the Agent is called,
-- so the user message is persisted and answered by nobody (measured in cp-1 task-106).
--
-- Fail loudly on dirty data instead of installing the constraint with NOT VALID: NOT VALID would
-- re-create exactly the hole this migration exists to close (a constraint that the existing rows do
-- not satisfy is enforced only for new writes, while the dangerous rows stay readable).
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM session_participants
               WHERE role = 'PRIMARY' AND principal_kind <> 'AGENT') THEN
        RAISE EXCEPTION 'V169 aborted: session_participants holds a non-AGENT PRIMARY row; fix the data first';
    END IF;
END $$;

ALTER TABLE session_participants
    ADD CONSTRAINT ck_session_participants_primary_kind
        CHECK (role <> 'PRIMARY' OR principal_kind = 'AGENT');

COMMENT ON CONSTRAINT ck_session_participants_primary_kind ON session_participants IS
    'PRIMARY is the answering participant and must be an AGENT (task-120; source cp-1 task-116 §B)';
