-- =============================================================================
-- XH Control Plane schema baseline (PLAN-280 destructive rebaseline)
--
-- Single canonical schema for fresh PostgreSQL 17 + pgvector installs.
-- Supersedes the historical V1~V22 + U6 chain (see one/plans/PLAN-280).
--
-- Conventions:
--   * Time columns use TIMESTAMPTZ with NOW() defaults.
--   * Ordinary tables use PostgreSQL native UUID ids; pure join tables keep
--     composite primary keys (workspace_users, mcp_tool_aliases).
--   * Every FK / CHECK / UNIQUE / index is explicitly named and every FK
--     declares ON DELETE.
--   * States are VARCHAR + named CHECK constraints (no PostgreSQL enums).
--   * Logical (unenforced) references are documented in DEV-019 and never
--     create FK cycles: chat_runs.user_message_id/assistant_message_id,
--     sessions/chat_runs.provider_connection_id, provider polymorphic owners,
--     provider_connection_audit.provider_connection_id.
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS vector;

-- -----------------------------------------------------------------------------
-- users / workspaces / membership
-- -----------------------------------------------------------------------------

CREATE TABLE users (
    id            UUID PRIMARY KEY,
    email        VARCHAR(255) NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    role         VARCHAR(20)  NOT NULL DEFAULT 'USER',
    name         VARCHAR(100),
    avatar       VARCHAR(512),
    settings     TEXT,
    created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    CONSTRAINT ck_users_role CHECK (role IN ('USER', 'ADMIN')),
    CONSTRAINT uq_users_email UNIQUE (email)
);

CREATE TABLE workspaces (
    id               UUID PRIMARY KEY,
    name             VARCHAR(255) NOT NULL,
    description      TEXT,
    owner_id         UUID         NOT NULL,
    settings         TEXT,
    storage_path     VARCHAR(512),
    storage_backend  VARCHAR(32)  NOT NULL DEFAULT 'host_directory',
    storage_ref      VARCHAR(64),
    generation       INT          NOT NULL DEFAULT 0,
    sandbox_spec_hash VARCHAR(64),
    sandbox_spec     JSONB,
    deleted_at       TIMESTAMPTZ,
    created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    CONSTRAINT fk_workspaces_owner FOREIGN KEY (owner_id) REFERENCES users (id),
    CONSTRAINT ck_workspaces_storage_backend CHECK (storage_backend IN ('host_directory'))
);

-- Partial uniques/indexes preserve soft-delete semantics.
CREATE UNIQUE INDEX uq_workspaces_active_owner
    ON workspaces (owner_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_workspaces_owner_active
    ON workspaces (owner_id, created_at) WHERE deleted_at IS NULL;

CREATE TABLE workspace_users (
    workspace_id UUID        NOT NULL,
    user_id      UUID        NOT NULL,
    role         VARCHAR(20) NOT NULL DEFAULT 'MEMBER',
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (workspace_id, user_id),
    CONSTRAINT fk_workspace_users_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE CASCADE,
    CONSTRAINT fk_workspace_users_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
    CONSTRAINT ck_workspace_users_role CHECK (role IN ('OWNER', 'MEMBER'))
);

CREATE INDEX idx_workspace_users_user_workspace
    ON workspace_users (user_id, workspace_id);

-- -----------------------------------------------------------------------------
-- sessions / messages / files
-- -----------------------------------------------------------------------------

CREATE TABLE sessions (
    id                     UUID PRIMARY KEY,
    workspace_id           UUID         NOT NULL,
    user_id                UUID         NOT NULL,
    title                  VARCHAR(255),
    model_provider         VARCHAR(50),
    model_name             VARCHAR(100),
    provider_connection_id UUID,
    connection_revision    BIGINT,
    archived               BOOLEAN      NOT NULL DEFAULT FALSE,
    created_at             TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at             TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    CONSTRAINT fk_sessions_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE CASCADE,
    CONSTRAINT fk_sessions_user FOREIGN KEY (user_id) REFERENCES users (id)
);

CREATE INDEX idx_sessions_workspace_user_active
    ON sessions (workspace_id, user_id, archived, created_at DESC);
CREATE INDEX idx_sessions_provider_connection
    ON sessions (provider_connection_id);

-- chat_runs precedes messages: messages.run_id references chat_runs.id.
-- chat_runs.user_message_id/assistant_message_id stay logical references to
-- avoid a table-level FK cycle (documented in DEV-019).
CREATE TABLE chat_runs (
    id                     UUID PRIMARY KEY,
    session_id             UUID         NOT NULL,
    user_id                UUID         NOT NULL,
    workspace_id           UUID         NOT NULL,
    idempotency_key        VARCHAR(128) NOT NULL,
    request_hash           VARCHAR(64)  NOT NULL,
    provider               VARCHAR(50),
    model                  VARCHAR(100),
    provider_connection_id UUID,
    connection_revision    BIGINT,
    tool_mode              VARCHAR(20)  NOT NULL DEFAULT 'none',
    user_message_id        UUID,
    assistant_message_id   UUID,
    status                 VARCHAR(24)  NOT NULL,
    terminal_outcome       VARCHAR(24),
    error_code             VARCHAR(64),
    error_detail           TEXT,
    token_count            INTEGER      NOT NULL DEFAULT 0,
    assistant_chars        INTEGER      NOT NULL DEFAULT 0,
    lease_owner            VARCHAR(80),
    lease_expires_at       TIMESTAMPTZ,
    created_at             TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at             TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    CONSTRAINT fk_chat_runs_session FOREIGN KEY (session_id) REFERENCES sessions (id) ON DELETE CASCADE,
    CONSTRAINT fk_chat_runs_user FOREIGN KEY (user_id) REFERENCES users (id),
    CONSTRAINT fk_chat_runs_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE CASCADE,
    CONSTRAINT uq_chat_runs_user_session_idempotency UNIQUE (user_id, session_id, idempotency_key)
);

CREATE INDEX idx_chat_runs_session_created ON chat_runs (session_id, created_at);
CREATE INDEX idx_chat_runs_provider_connection
    ON chat_runs (provider_connection_id, connection_revision);
CREATE INDEX idx_chat_runs_active_lease
    ON chat_runs (session_id, status, lease_expires_at);

CREATE TABLE messages (
    id         UUID PRIMARY KEY,
    session_id UUID        NOT NULL,
    run_id     UUID,
    role       VARCHAR(20) NOT NULL,
    content    TEXT        NOT NULL,
    metadata   TEXT,
    attachments TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT fk_messages_session FOREIGN KEY (session_id) REFERENCES sessions (id) ON DELETE CASCADE,
    CONSTRAINT fk_messages_run FOREIGN KEY (run_id) REFERENCES chat_runs (id) ON DELETE SET NULL,
    CONSTRAINT ck_messages_role CHECK (role IN ('USER', 'ASSISTANT', 'SYSTEM'))
);

CREATE INDEX idx_messages_session_id ON messages (session_id);
CREATE INDEX idx_messages_run_id ON messages (run_id);

CREATE TABLE files (
    id           UUID PRIMARY KEY,
    user_id      UUID         NOT NULL,
    workspace_id UUID,
    session_id   UUID,
    message_id   UUID,
    filename     VARCHAR(255) NOT NULL,
    mime_type    VARCHAR(127),
    size_bytes   BIGINT       NOT NULL DEFAULT 0,
    storage_path VARCHAR(512) NOT NULL,
    created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    CONSTRAINT fk_files_user FOREIGN KEY (user_id) REFERENCES users (id),
    CONSTRAINT fk_files_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE SET NULL,
    CONSTRAINT fk_files_session FOREIGN KEY (session_id) REFERENCES sessions (id) ON DELETE CASCADE,
    CONSTRAINT fk_files_message FOREIGN KEY (message_id) REFERENCES messages (id) ON DELETE SET NULL
);

CREATE INDEX idx_files_user_id ON files (user_id);
CREATE INDEX idx_files_workspace_id ON files (workspace_id);
CREATE INDEX idx_files_session_id ON files (session_id);
CREATE INDEX idx_files_message_id ON files (message_id);

-- -----------------------------------------------------------------------------
-- workspace execution specs (lifecycle snapshots, PLAN-262)
-- -----------------------------------------------------------------------------

CREATE TABLE workspace_execution_specs (
    id              UUID PRIMARY KEY,
    workspace_id    UUID        NOT NULL,
    generation      INT         NOT NULL,
    sandbox_spec_hash VARCHAR(64) NOT NULL,
    sandbox_spec    JSONB       NOT NULL,
    storage_backend VARCHAR(32) NOT NULL DEFAULT 'host_directory',
    storage_ref     VARCHAR(64) NOT NULL,
    actor           VARCHAR(255),
    reason          VARCHAR(512),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT fk_workspace_execution_specs_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE CASCADE,
    CONSTRAINT uq_workspace_execution_specs_workspace_generation UNIQUE (workspace_id, generation)
);

CREATE INDEX idx_workspace_execution_specs_workspace_generation
    ON workspace_execution_specs (workspace_id, generation);

-- -----------------------------------------------------------------------------
-- MCP servers / tool aliases / OAuth credentials
-- -----------------------------------------------------------------------------

CREATE TABLE mcp_servers (
    id          UUID PRIMARY KEY,
    workspace_id UUID         NOT NULL,
    name        VARCHAR(255) NOT NULL,
    endpoint    VARCHAR(512) NOT NULL,
    auth_mode   VARCHAR(16)  NOT NULL DEFAULT 'oauth',
    auth_config TEXT,
    enabled     BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    CONSTRAINT fk_mcp_servers_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE CASCADE,
    CONSTRAINT ck_mcp_servers_auth_mode CHECK (auth_mode IN ('oauth', 'no-auth'))
);

CREATE INDEX idx_mcp_servers_workspace_id ON mcp_servers (workspace_id);

CREATE TABLE mcp_tool_aliases (
    workspace_id UUID         NOT NULL,
    issued_name  VARCHAR(255) NOT NULL,
    server_id    UUID         NOT NULL,
    backend_name VARCHAR(255) NOT NULL,
    generation   BIGINT       NOT NULL DEFAULT 0,
    created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    PRIMARY KEY (workspace_id, issued_name),
    CONSTRAINT fk_mcp_tool_aliases_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE CASCADE,
    CONSTRAINT fk_mcp_tool_aliases_server FOREIGN KEY (server_id) REFERENCES mcp_servers (id) ON DELETE CASCADE
);

CREATE INDEX idx_mcp_tool_aliases_server
    ON mcp_tool_aliases (workspace_id, server_id);

CREATE TABLE oauth_credentials (
    id                       UUID PRIMARY KEY,
    user_id                  UUID         NOT NULL,
    workspace_id             UUID         NOT NULL,
    server_id                UUID         NOT NULL,
    client_id                VARCHAR(255) NOT NULL,
    token_endpoint           VARCHAR(512) NOT NULL,
    redirect_uri             VARCHAR(512) NOT NULL,
    scope                    VARCHAR(1024) NOT NULL,
    refresh_token_ciphertext TEXT         NOT NULL,
    encryption_key_version   VARCHAR(32)  NOT NULL,
    status                   VARCHAR(32)  NOT NULL DEFAULT 'AUTHORIZED',
    created_at               TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at               TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    CONSTRAINT fk_oauth_credentials_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
    CONSTRAINT fk_oauth_credentials_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE CASCADE,
    CONSTRAINT fk_oauth_credentials_server FOREIGN KEY (server_id) REFERENCES mcp_servers (id) ON DELETE CASCADE,
    CONSTRAINT uq_oauth_credential_binding UNIQUE (user_id, workspace_id, server_id)
);

CREATE INDEX idx_oauth_credentials_workspace ON oauth_credentials (workspace_id);
CREATE INDEX idx_oauth_credentials_server ON oauth_credentials (server_id);

-- -----------------------------------------------------------------------------
-- context event store (PLAN-035)
-- -----------------------------------------------------------------------------

CREATE TABLE context_events (
    id             UUID PRIMARY KEY,
    session_id     UUID        NOT NULL,
    workspace_id   UUID        NOT NULL,
    user_id        UUID        NOT NULL,
    event_type     VARCHAR(50) NOT NULL,
    sequence       BIGINT      NOT NULL,
    payload        JSONB       NOT NULL DEFAULT '{}',
    correlation_id VARCHAR(36),
    causation_id   VARCHAR(36),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT fk_context_events_session FOREIGN KEY (session_id) REFERENCES sessions (id) ON DELETE CASCADE,
    CONSTRAINT fk_context_events_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE CASCADE,
    CONSTRAINT fk_context_events_user FOREIGN KEY (user_id) REFERENCES users (id),
    CONSTRAINT uq_context_events_session_sequence UNIQUE (session_id, sequence)
);

CREATE INDEX idx_context_events_session_sequence ON context_events (session_id, sequence);
CREATE INDEX idx_context_events_workspace_id ON context_events (workspace_id);
CREATE INDEX idx_context_events_event_type ON context_events (event_type);

CREATE TABLE context_projections (
    id              UUID PRIMARY KEY,
    session_id      UUID        NOT NULL,
    workspace_id    UUID        NOT NULL,
    user_id         UUID        NOT NULL,
    projection_type VARCHAR(50) NOT NULL DEFAULT 'agent_context',
    latest_sequence BIGINT      NOT NULL DEFAULT 0,
    payload         JSONB       NOT NULL DEFAULT '{}',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT fk_context_projections_session FOREIGN KEY (session_id) REFERENCES sessions (id) ON DELETE CASCADE,
    CONSTRAINT fk_context_projections_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE CASCADE,
    CONSTRAINT fk_context_projections_user FOREIGN KEY (user_id) REFERENCES users (id),
    CONSTRAINT uq_context_projections_session UNIQUE (session_id)
);

CREATE INDEX idx_context_projections_workspace_id ON context_projections (workspace_id);

CREATE TABLE context_source_hashes (
    id           UUID PRIMARY KEY,
    workspace_id UUID         NOT NULL,
    source_key   VARCHAR(255) NOT NULL,
    hash         VARCHAR(64)  NOT NULL,
    created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    CONSTRAINT fk_context_source_hashes_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE CASCADE,
    CONSTRAINT uq_context_source_hashes_workspace_source UNIQUE (workspace_id, source_key)
);

CREATE INDEX idx_context_source_hashes_source_key ON context_source_hashes (source_key);

-- -----------------------------------------------------------------------------
-- unified config (PLAN-042)
-- -----------------------------------------------------------------------------

CREATE TABLE config (
    id           UUID PRIMARY KEY,
    environment  VARCHAR(64) NOT NULL DEFAULT 'default',
    layer        VARCHAR(16) NOT NULL,
    domain       VARCHAR(32) NOT NULL,
    config_key   VARCHAR(64) NOT NULL,
    config_value TEXT,
    mcp_config   JSONB,
    is_set       BOOLEAN     NOT NULL DEFAULT TRUE,
    updated_by   VARCHAR(64),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_config_scope UNIQUE (environment, layer, domain, config_key)
);

CREATE INDEX idx_config_lookup ON config (environment, layer, domain);

CREATE TABLE config_audit (
    id           UUID PRIMARY KEY,
    config_id    UUID        NOT NULL,
    environment  VARCHAR(64),
    layer        VARCHAR(16),
    domain       VARCHAR(32),
    config_key   VARCHAR(64),
    old_value    TEXT,
    new_value    TEXT,
    changed_by   VARCHAR(64),
    changed_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT fk_config_audit_config FOREIGN KEY (config_id) REFERENCES config (id) ON DELETE CASCADE
);

CREATE INDEX idx_config_audit_config_id ON config_audit (config_id);

-- -----------------------------------------------------------------------------
-- audit logs
-- -----------------------------------------------------------------------------

CREATE TABLE audit_logs (
    id            UUID PRIMARY KEY,
    user_id       UUID,
    workspace_id  UUID,
    action        VARCHAR(100) NOT NULL,
    resource_type VARCHAR(50),
    resource_id   VARCHAR(36),
    details       TEXT,
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    CONSTRAINT fk_audit_logs_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE SET NULL,
    CONSTRAINT fk_audit_logs_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE SET NULL
);

CREATE INDEX idx_audit_logs_user_id ON audit_logs (user_id);
CREATE INDEX idx_audit_logs_workspace_id ON audit_logs (workspace_id);
CREATE INDEX idx_audit_logs_action ON audit_logs (action);

-- -----------------------------------------------------------------------------
-- approval requests (PLAN-271)
-- -----------------------------------------------------------------------------

CREATE TABLE approval_requests (
    request_id          UUID PRIMARY KEY,
    run_id              UUID         NOT NULL,
    session_id          UUID         NOT NULL,
    user_id             UUID         NOT NULL,
    workspace_id        UUID         NOT NULL,
    tool                VARCHAR(80)  NOT NULL,
    action              VARCHAR(512) NOT NULL,
    details             TEXT,
    state               VARCHAR(24)  NOT NULL,
    approved            BOOLEAN,
    expires_at          TIMESTAMPTZ  NOT NULL,
    created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    decided_at          TIMESTAMPTZ,
    dispatch_error_code VARCHAR(64),
    CONSTRAINT fk_approval_requests_run FOREIGN KEY (run_id) REFERENCES chat_runs (id) ON DELETE CASCADE,
    CONSTRAINT fk_approval_requests_session FOREIGN KEY (session_id) REFERENCES sessions (id) ON DELETE CASCADE,
    CONSTRAINT fk_approval_requests_user FOREIGN KEY (user_id) REFERENCES users (id),
    CONSTRAINT fk_approval_requests_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE CASCADE,
    CONSTRAINT ck_approval_requests_state CHECK (state IN ('pending', 'dispatching', 'approved', 'rejected', 'expired', 'dispatch_unknown'))
);

CREATE INDEX idx_approval_requests_session_state
    ON approval_requests (session_id, user_id, workspace_id, state, created_at);
CREATE INDEX idx_approval_requests_run_state
    ON approval_requests (run_id, state);

-- -----------------------------------------------------------------------------
-- provider connections (PLAN-261) + credential leases + audit
-- -----------------------------------------------------------------------------

CREATE TABLE provider_connections (
    id                      UUID PRIMARY KEY,
    owner_type              VARCHAR(16)  NOT NULL,
    owner_id                VARCHAR(64)  NOT NULL,
    provider_id             VARCHAR(128) NOT NULL,
    label                   VARCHAR(128) NOT NULL,
    base_url                VARCHAR(2048),
    credential_ciphertext   TEXT,
    encryption_key_version  VARCHAR(32)  NOT NULL,
    enabled                 BOOLEAN      NOT NULL DEFAULT TRUE,
    status                  VARCHAR(32)  NOT NULL DEFAULT 'UNVERIFIED',
    model_discovery         VARCHAR(32)  NOT NULL DEFAULT 'remote-models',
    manual_models           JSONB,
    revision                BIGINT       NOT NULL DEFAULT 1,
    last_verified_at        TIMESTAMPTZ,
    last_error_code         VARCHAR(64),
    created_at              TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    CONSTRAINT ck_provider_connection_owner_type CHECK (owner_type IN ('SYSTEM', 'WORKSPACE', 'USER')),
    CONSTRAINT ck_provider_connection_status CHECK (status IN ('UNVERIFIED', 'VERIFYING', 'READY', 'INVALID_CREDENTIALS', 'UNREACHABLE', 'DISABLED')),
    CONSTRAINT ck_provider_connection_discovery CHECK (model_discovery IN ('remote-models', 'litellm-catalog', 'curated', 'manual')),
    CONSTRAINT uq_provider_connection_scope UNIQUE (owner_type, owner_id, provider_id)
);

CREATE INDEX idx_provider_connections_owner
    ON provider_connections (owner_type, owner_id, enabled);
CREATE INDEX idx_provider_connections_provider_status
    ON provider_connections (provider_id, status, enabled);

CREATE TABLE provider_credential_leases (
    id                     UUID PRIMARY KEY,
    lease_hash             VARCHAR(128) NOT NULL,
    provider_connection_id UUID         NOT NULL,
    user_id                UUID         NOT NULL,
    workspace_id           UUID,
    session_id             UUID,
    run_id                 UUID,
    provider_id            VARCHAR(128) NOT NULL,
    model                  VARCHAR(255) NOT NULL,
    expires_at             TIMESTAMPTZ  NOT NULL,
    redeemed_at            TIMESTAMPTZ,
    revoked_at             TIMESTAMPTZ,
    created_at             TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    CONSTRAINT fk_provider_credential_leases_connection FOREIGN KEY (provider_connection_id) REFERENCES provider_connections (id) ON DELETE CASCADE,
    CONSTRAINT fk_provider_credential_leases_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
    CONSTRAINT fk_provider_credential_leases_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE CASCADE,
    CONSTRAINT fk_provider_credential_leases_session FOREIGN KEY (session_id) REFERENCES sessions (id) ON DELETE CASCADE,
    CONSTRAINT fk_provider_credential_leases_run FOREIGN KEY (run_id) REFERENCES chat_runs (id) ON DELETE CASCADE,
    CONSTRAINT uq_provider_credential_leases_hash UNIQUE (lease_hash)
);

CREATE INDEX idx_provider_credential_leases_expiry
    ON provider_credential_leases (expires_at);
CREATE INDEX idx_provider_credential_leases_binding
    ON provider_credential_leases (provider_connection_id, user_id, run_id);

-- provider_connection_audit.provider_connection_id stays a logical reference:
-- audit rows must survive connection deletion (PLAN-261).
CREATE TABLE provider_connection_audit (
    id                     UUID PRIMARY KEY,
    provider_connection_id UUID,
    owner_type             VARCHAR(16)  NOT NULL,
    owner_id               VARCHAR(64)  NOT NULL,
    provider_id            VARCHAR(128) NOT NULL,
    action                 VARCHAR(32)  NOT NULL,
    changed_by             VARCHAR(64)  NOT NULL,
    from_status            VARCHAR(32),
    to_status              VARCHAR(32),
    credential_present     BOOLEAN      NOT NULL DEFAULT FALSE,
    credential_last4       VARCHAR(4),
    connection_revision    BIGINT       NOT NULL,
    created_at             TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_provider_connection_audit_connection
    ON provider_connection_audit (provider_connection_id, created_at);
CREATE INDEX idx_provider_connection_audit_owner
    ON provider_connection_audit (owner_type, owner_id, created_at);
