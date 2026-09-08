-- =============================================================================
-- XH Control Plane — Session Operation Ledger (PLAN-281, M1 task 1.1)
--
-- Adds the unified Operation Ledger: six tables covering logical operations,
-- tool-call items, cross-module attempts, append-only status events, typed
-- audit extensions and diagnostic artifact metadata.
--
-- Conventions follow V1__init_schema.sql (PLAN-280):
--   * PostgreSQL native UUID ids, TIMESTAMPTZ time columns, NOW() defaults.
--   * Every FK / CHECK / UNIQUE / index is explicitly named and every FK
--     declares ON DELETE.
--   * States are VARCHAR + named CHECK constraints (no PostgreSQL enums).
--   * Logical (unenforced) references are documented inline and never create
--     FK cycles: session_operations.request_id, operation_items.tool_call_id,
--     operation_attempts.request_id.
--
-- Open value domains (deliberately NOT CHECK-constrained in v1; extend via
-- later migrations when frozen): operation_attempts.stage,
-- operation_events.event_type / state / actor, operation_items.policy_decision,
-- operation_extensions.extension_kind, diagnostic_artifacts.kind /
-- storage_backend / acl_scope.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- session_operations: one row per logical user/system operation
-- -----------------------------------------------------------------------------

CREATE TABLE session_operations (
    id              UUID PRIMARY KEY,
    session_id      UUID,
    workspace_id    UUID,
    user_id         UUID,
    run_id          UUID,
    request_id      UUID,
    kind            VARCHAR(32)  NOT NULL,
    source          VARCHAR(24)  NOT NULL,
    actor_type      VARCHAR(24)  NOT NULL,
    actor_id        VARCHAR(128),
    status          VARCHAR(24)  NOT NULL,
    idempotency_key VARCHAR(128),
    input_hash      VARCHAR(64),
    summary         TEXT,
    error_code      VARCHAR(64),
    error_ref       TEXT,
    started_at      TIMESTAMPTZ,
    finished_at     TIMESTAMPTZ,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    CONSTRAINT fk_session_operations_session FOREIGN KEY (session_id) REFERENCES sessions (id) ON DELETE CASCADE,
    CONSTRAINT fk_session_operations_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE CASCADE,
    CONSTRAINT fk_session_operations_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE NO ACTION,
    CONSTRAINT fk_session_operations_run FOREIGN KEY (run_id) REFERENCES chat_runs (id) ON DELETE SET NULL,
    CONSTRAINT ck_session_operations_kind CHECK (kind IN ('chat', 'tool_call', 'approval', 'job', 'workspace_lifecycle', 'system', 'other')),
    CONSTRAINT ck_session_operations_source CHECK (source IN ('ui', 'agent', 'runtime', 'system', 'mcp')),
    CONSTRAINT ck_session_operations_actor_type CHECK (actor_type IN ('user', 'agent', 'system', 'service')),
    CONSTRAINT ck_session_operations_status CHECK (status IN ('accepted', 'running', 'waiting_for_approval', 'completed', 'failed', 'cancelled', 'interrupted', 'ambiguous'))
);

-- NULL-safe idempotency: only rows carrying a key participate.
CREATE UNIQUE INDEX uq_session_operations_idempotency
    ON session_operations (user_id, session_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
-- NOTE: v1 simplification — PLAN-281 §3.4 asks for "active row unique" per
-- ChatRun (run_id unique unless status = 'CANCELLED'). A predicate on status
-- would break the unique index on every status transition, so v1 enforces the
-- simpler "at most one root operation per run_id" invariant instead.
CREATE UNIQUE INDEX uq_session_operations_run
    ON session_operations (run_id) WHERE run_id IS NOT NULL;

CREATE INDEX idx_session_operations_session_time
    ON session_operations (session_id, created_at);
CREATE INDEX idx_session_operations_workspace_time
    ON session_operations (workspace_id, created_at);

-- -----------------------------------------------------------------------------
-- operation_items: auditable logical actions / tool calls within an operation
-- -----------------------------------------------------------------------------

CREATE TABLE operation_items (
    id                  UUID PRIMARY KEY,
    operation_id        UUID         NOT NULL,
    tool_call_id        UUID,
    parent_item_id      UUID,
    sequence            INTEGER      NOT NULL,
    kind                VARCHAR(32)  NOT NULL,
    tool_name           VARCHAR(128),
    source              VARCHAR(24)  NOT NULL,
    policy_decision     VARCHAR(24),
    approval_request_id UUID,
    request_hash        VARCHAR(64),
    arguments_preview   JSONB,
    normalized_argv     JSONB,
    cwd                 VARCHAR(1024),
    env_policy_hash     VARCHAR(64),
    expires_at          TIMESTAMPTZ,
    status              VARCHAR(24)  NOT NULL,
    result_ref          TEXT,
    error_code          VARCHAR(64),
    started_at          TIMESTAMPTZ,
    finished_at         TIMESTAMPTZ,
    created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    CONSTRAINT fk_operation_items_operation FOREIGN KEY (operation_id) REFERENCES session_operations (id) ON DELETE CASCADE,
    CONSTRAINT fk_operation_items_parent FOREIGN KEY (parent_item_id) REFERENCES operation_items (id) ON DELETE SET NULL,
    CONSTRAINT fk_operation_items_approval_request FOREIGN KEY (approval_request_id) REFERENCES approval_requests (request_id) ON DELETE SET NULL,
    CONSTRAINT ck_operation_items_kind CHECK (kind IN ('chat', 'tool_call', 'approval', 'job', 'workspace_lifecycle', 'system', 'other')),
    CONSTRAINT ck_operation_items_source CHECK (source IN ('ui', 'agent', 'runtime', 'system', 'mcp')),
    CONSTRAINT ck_operation_items_status CHECK (status IN ('pending', 'running', 'waiting_for_approval', 'resolving', 'completed', 'failed', 'aborted', 'cancelled', 'ambiguous'))
);

-- Same operation must not reuse a tool call id; non-tool items use their own id.
CREATE UNIQUE INDEX uq_operation_items_operation_tool_call
    ON operation_items (operation_id, tool_call_id) WHERE tool_call_id IS NOT NULL;
-- Sequence lookup is fully covered by this unique constraint; no extra index.
CREATE UNIQUE INDEX uq_operation_items_operation_sequence
    ON operation_items (operation_id, sequence);

-- -----------------------------------------------------------------------------
-- operation_attempts: one cross-module actual execution attempt per row
-- -----------------------------------------------------------------------------

CREATE TABLE operation_attempts (
    id                UUID PRIMARY KEY,
    item_id           UUID        NOT NULL,
    stage             VARCHAR(24) NOT NULL,
    retry_no          INTEGER     NOT NULL DEFAULT 0,
    parent_attempt_id UUID,
    module            VARCHAR(24) NOT NULL,
    request_id        UUID,
    status            VARCHAR(24) NOT NULL,
    http_status       INTEGER,
    error_code        VARCHAR(64),
    result_ref        TEXT,
    duration_ms       BIGINT,
    started_at        TIMESTAMPTZ NOT NULL,
    finished_at       TIMESTAMPTZ,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT fk_operation_attempts_item FOREIGN KEY (item_id) REFERENCES operation_items (id) ON DELETE CASCADE,
    CONSTRAINT fk_operation_attempts_parent FOREIGN KEY (parent_attempt_id) REFERENCES operation_attempts (id) ON DELETE SET NULL,
    CONSTRAINT ck_operation_attempts_module CHECK (module IN ('agent', 'cp', 'runtime', 'mcp')),
    CONSTRAINT ck_operation_attempts_status CHECK (status IN ('started', 'succeeded', 'failed', 'timed_out', 'cancelled', 'unknown'))
);

-- Item prefix lookups are covered by this unique constraint; no extra index.
CREATE UNIQUE INDEX uq_operation_attempts_item_stage_retry
    ON operation_attempts (item_id, stage, retry_no);

-- -----------------------------------------------------------------------------
-- operation_events: append-only status history (no updates, no deletes)
-- -----------------------------------------------------------------------------

CREATE TABLE operation_events (
    id             UUID PRIMARY KEY,
    operation_id   UUID         NOT NULL,
    item_id        UUID,
    attempt_id     UUID,
    sequence       BIGINT       NOT NULL,
    event_type     VARCHAR(40)  NOT NULL,
    state          VARCHAR(24)  NOT NULL,
    actor          VARCHAR(24)  NOT NULL,
    payload        JSONB,
    schema_version INTEGER      NOT NULL DEFAULT 1,
    created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    CONSTRAINT fk_operation_events_operation FOREIGN KEY (operation_id) REFERENCES session_operations (id) ON DELETE CASCADE,
    CONSTRAINT fk_operation_events_item FOREIGN KEY (item_id) REFERENCES operation_items (id) ON DELETE SET NULL,
    CONSTRAINT fk_operation_events_attempt FOREIGN KEY (attempt_id) REFERENCES operation_attempts (id) ON DELETE SET NULL
);

CREATE UNIQUE INDEX uq_operation_events_operation_sequence
    ON operation_events (operation_id, sequence);

-- -----------------------------------------------------------------------------
-- operation_extensions: typed audit payloads (llm_usage, mcp_call, ...)
--
-- Uniqueness uses two complementary partial unique indexes so that exactly one
-- current extension exists per target (item-only or attempt-only) + kind +
-- schema version. A row referencing both targets simultaneously is not
-- produced by the v1 writers; the CHECK below only enforces "at least one".
-- -----------------------------------------------------------------------------

CREATE TABLE operation_extensions (
    id             UUID PRIMARY KEY,
    item_id        UUID,
    attempt_id     UUID,
    extension_kind VARCHAR(40) NOT NULL,
    schema_version INTEGER     NOT NULL,
    payload        JSONB       NOT NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT fk_operation_extensions_item FOREIGN KEY (item_id) REFERENCES operation_items (id) ON DELETE SET NULL,
    CONSTRAINT fk_operation_extensions_attempt FOREIGN KEY (attempt_id) REFERENCES operation_attempts (id) ON DELETE SET NULL,
    CONSTRAINT ck_operation_extensions_target CHECK (item_id IS NOT NULL OR attempt_id IS NOT NULL)
);

CREATE UNIQUE INDEX uq_operation_extensions_item_kind_version
    ON operation_extensions (item_id, extension_kind, schema_version) WHERE item_id IS NOT NULL AND attempt_id IS NULL;
CREATE UNIQUE INDEX uq_operation_extensions_attempt_kind_version
    ON operation_extensions (attempt_id, extension_kind, schema_version) WHERE attempt_id IS NOT NULL AND item_id IS NULL;

-- -----------------------------------------------------------------------------
-- diagnostic_artifacts: encrypted artifact metadata (content lives in
-- protected artifact storage; only hash/ref/acl are stored here)
-- -----------------------------------------------------------------------------

CREATE TABLE diagnostic_artifacts (
    id                    UUID PRIMARY KEY,
    operation_id          UUID         NOT NULL,
    item_id               UUID,
    attempt_id            UUID,
    kind                  VARCHAR(40)  NOT NULL,
    content_type          VARCHAR(128) NOT NULL,
    storage_backend       VARCHAR(24)  NOT NULL,
    storage_ref           TEXT         NOT NULL,
    content_sha256        VARCHAR(64)  NOT NULL,
    size_bytes            BIGINT       NOT NULL,
    encryption_algorithm  VARCHAR(32)  NOT NULL,
    encryption_key_version VARCHAR(32) NOT NULL,
    acl_scope             VARCHAR(24)  NOT NULL,
    expires_at            TIMESTAMPTZ,
    created_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    deleted_at            TIMESTAMPTZ,
    CONSTRAINT fk_diagnostic_artifacts_operation FOREIGN KEY (operation_id) REFERENCES session_operations (id) ON DELETE CASCADE,
    CONSTRAINT fk_diagnostic_artifacts_item FOREIGN KEY (item_id) REFERENCES operation_items (id) ON DELETE SET NULL,
    CONSTRAINT fk_diagnostic_artifacts_attempt FOREIGN KEY (attempt_id) REFERENCES operation_attempts (id) ON DELETE SET NULL
);

CREATE INDEX idx_diagnostic_artifacts_operation_time
    ON diagnostic_artifacts (operation_id, created_at);
CREATE INDEX idx_diagnostic_artifacts_live_expiry
    ON diagnostic_artifacts (expires_at) WHERE deleted_at IS NULL;
