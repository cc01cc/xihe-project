-- PLAN-0679 (design D1): per-run provider-request fingerprint.
--
-- One row per run holding the layered sha256 fingerprint of the FINAL provider request body sent
-- for the run's FIRST provider step (design 4.2: systemTemplate / history / userInput / toolSchema /
-- config + the outbound calibration layer). The Agent emits one `provider_request_fingerprint`
-- event per run; the write is guarded by `ON CONFLICT (run_id) DO NOTHING`, so a context-overflow
-- re-dispatch of the same run (which re-enters the first provider step from the Agent's point of
-- view) cannot replace the first document (design D2). Row absence is named by the read side as the
-- envelope reason `not_captured` and is never re-encoded as `disabled`/`error` (two-level model,
-- design D5, PLAN-0666 D5).
--
-- Zero prompt content (design D5): only hashes, counts, byte sizes and source metadata (api type,
-- resolved model, role counts, slot fill state) are stored. No message bodies, no tool arguments.
--
-- No secondary index: the table is only ever read by primary key (single-run read / diff by runId),
-- the same coverage argument as `chat_runs` (PLAN-0666 design D2 / review round-01: no extra index).
-- v1 PK = run_id; per-step multi-row is v2 (B-6) and migrates cleanly then — development data has
-- no migration burden (D-215).
--
-- Flyway number taken at commit time (V132, 2026-11-06): three-check = develop tip / all
-- `.worktrees` checkouts / `flyway_schema_history` watermark; file-side max was V131 in all nine
-- checkouts at 2026-11-06 18:2x (+08), and the DB watermark is re-checked in the real-stack window
-- (development data has no migration burden, D-215). Numbers are never reserved ahead of merge
-- (A03 control-plane AGENTS.md "Flyway 号不预留").
CREATE TABLE chat_run_provider_requests (
    run_id           UUID PRIMARY KEY REFERENCES chat_runs (id) ON DELETE CASCADE,
    dispatch_attempt INT          NOT NULL DEFAULT 1,  -- v1 constant 1 (design D2)
    provider_step    INT          NOT NULL DEFAULT 1,  -- v1 constant 1 (B-6: per-step is v2)
    api_type_id      VARCHAR(64)  NOT NULL,
    api_type_version INT,                              -- design draft said VARCHAR(32); INT matches
                                                       -- provider_connections.api_type_version (the
                                                       -- value the Agent reports is numeric)
    model            VARCHAR(255) NOT NULL,            -- resolved model actually dispatched
    message_count    INT          NOT NULL,            -- rendered native records of the first step
    tool_count       INT          NOT NULL,
    bytes_total      BIGINT       NOT NULL,            -- canonical bytes of the complete body
    role_histogram   JSONB        NOT NULL DEFAULT '{}'::jsonb,  -- {"user":1,...} counts only
    system_sources   JSONB        NOT NULL DEFAULT '{}'::jsonb,  -- slot fill state etc. (metadata only)
    fingerprint      JSONB        NOT NULL,                      -- design 4.2 six-layer document
    created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE chat_run_provider_requests IS
    'PLAN-0679: per-run final provider-request fingerprint (six-layer sha256 summary, zero prompt content). '
    'Write-once: INSERT ... ON CONFLICT (run_id) DO NOTHING. Row absence = read-side not_captured.';

COMMENT ON COLUMN chat_run_provider_requests.fingerprint IS
    'PLAN-0679: {"algo":"sha256","dispatchAttempt":1,"providerStep":1,"layers":{...},"outbound":{hash,bytes}}. '
    'Only hashes/counts/bytes and configuration key names; never prompt content (design D5).';
