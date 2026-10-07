-- PLAN-0464 T1.5: approval domain transition history + the FK 0463 deferred.
--
-- Delta-only:
--   1. approval_history — append-only流转记录 covering
--      pending(requested) → dispatching → decided / expired / dispatch_unknown.
--      It replaces the eight Operation-ledger write sites in ApprovalService
--      (recordLedgerApprovalItem x3, resolveApprovalItem x3,
--      transitionOperationForRun x2); no legacy Ledger data is migrated
--      (PLAN-0462 decision #9).
--   2. mcp_invocations.approval_request_id hard FK, deferred by PLAN-0463
--      (wire-contract 4.1 / implementation 遗留 3) until this plan created the
--      approval-side binding. ON DELETE SET NULL keeps session/approval cascades
--      from blocking on a settled invocation row.

CREATE TABLE approval_history (
    id            UUID PRIMARY KEY,
    request_id    UUID         NOT NULL REFERENCES approval_requests (request_id) ON DELETE CASCADE,
    run_id        UUID,
    session_id    UUID,
    sequence      BIGINT       NOT NULL,
    event_type    VARCHAR(32)  NOT NULL,
    from_state    VARCHAR(24),
    to_state      VARCHAR(24)  NOT NULL,
    approved      BOOLEAN,
    decision_kind VARCHAR(48),
    actor_type    VARCHAR(16)  NOT NULL,
    payload       TEXT,
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    CONSTRAINT ck_approval_history_event CHECK (
        event_type IN ('requested', 'dispatching', 'decided', 'expired',
                       'dispatch_unknown')),
    CONSTRAINT ck_approval_history_actor CHECK (
        actor_type IN ('system', 'agent', 'cp', 'user', 'answerer'))
);

CREATE UNIQUE INDEX uq_approval_history_request_sequence
    ON approval_history (request_id, sequence);

CREATE INDEX idx_approval_history_run_created
    ON approval_history (run_id, created_at);

ALTER TABLE mcp_invocations
    ADD CONSTRAINT fk_mcp_invocations_approval_request
    FOREIGN KEY (approval_request_id) REFERENCES approval_requests (request_id)
    ON DELETE SET NULL;
