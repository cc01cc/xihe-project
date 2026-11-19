-- task-103 (D-1869①): provider call record completion, per-step rows with verbatim bytes.
--
-- 1) V132 reserved the per-step shape as B-6; the primary key becomes (run_id, provider_step) so a
--    re-dispatched run keeps one row per provider step (retries = row count - 1).
-- 2) Durable record keeps the request/response/error bytes VERBATIM (user ruling 2026-11-19 10:5x,
--    DEV-004 6.5b): no redaction, no rewriting - byte equality + sha256 + byte count is the proof.
--    providerAudit=off writes NULL, never 0 and never an empty string.
--
-- D-215: development data is disposable, so no backfill runs here; existing rows keep NULL bodies
-- (and are honestly read as 'not captured', not as an empty request).
ALTER TABLE chat_run_provider_requests DROP CONSTRAINT IF EXISTS chat_run_provider_requests_pkey;
ALTER TABLE chat_run_provider_requests ADD PRIMARY KEY (run_id, provider_step);

ALTER TABLE chat_run_provider_requests
    ADD COLUMN tier varchar(16) NOT NULL DEFAULT 'metadata',
    ADD COLUMN http_status integer,
    ADD COLUMN streamed boolean,
    ADD COLUMN finish_reason varchar(64),
    ADD COLUMN ttft_ms integer,
    ADD COLUMN total_ms integer,
    ADD COLUMN request_sha256 varchar(64),
    ADD COLUMN request_bytes bigint,
    ADD COLUMN request_body bytea,
    ADD COLUMN response_sha256 varchar(64),
    ADD COLUMN response_bytes bigint,
    ADD COLUMN response_body bytea,
    ADD COLUMN error_sha256 varchar(64),
    ADD COLUMN error_bytes bigint,
    ADD COLUMN error_body bytea,
    ADD COLUMN cache_read_input_tokens bigint,
    ADD COLUMN cache_write_input_tokens bigint,
    ADD COLUMN request_params jsonb,
    ADD COLUMN tool_surface jsonb,
    ADD COLUMN provider_audit jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN chat_run_provider_requests.request_body IS
    'Verbatim request wire bytes (providerAudit=full); NULL means not captured, never empty.';
COMMENT ON COLUMN chat_run_provider_requests.response_body IS
    'Verbatim response bytes/SSE stream (providerAudit=full); NULL means not captured.';
COMMENT ON COLUMN chat_run_provider_requests.cache_read_input_tokens IS
    'Provider-reported cache hit tokens; NULL when the provider reported none (never 0 as a stand-in).';
COMMENT ON COLUMN chat_run_provider_requests.provider_audit IS
    'Audit block as emitted by the Agent (tier/status/timings/finishReason/params/tool surface).';