CREATE TABLE provider_connections (
    id                       VARCHAR(36)  PRIMARY KEY,
    owner_type               VARCHAR(16)  NOT NULL,
    owner_id                 VARCHAR(64)  NOT NULL,
    provider_id              VARCHAR(128) NOT NULL,
    label                    VARCHAR(128) NOT NULL,
    base_url                 VARCHAR(2048),
    credential_ciphertext    TEXT,
    encryption_key_version   VARCHAR(32)  NOT NULL,
    enabled                  BOOLEAN      NOT NULL DEFAULT TRUE,
    status                   VARCHAR(32)  NOT NULL DEFAULT 'UNVERIFIED',
    model_discovery          VARCHAR(32)  NOT NULL DEFAULT 'remote-models',
    manual_models            JSONB,
    revision                 BIGINT       NOT NULL DEFAULT 1,
    last_verified_at         TIMESTAMPTZ,
    last_error_code          VARCHAR(64),
    created_at               TIMESTAMPTZ  NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at               TIMESTAMPTZ  NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT ck_provider_connection_owner_type
        CHECK (owner_type IN ('SYSTEM', 'WORKSPACE', 'USER')),
    CONSTRAINT ck_provider_connection_status
        CHECK (status IN ('UNVERIFIED', 'VERIFYING', 'READY', 'INVALID_CREDENTIALS', 'UNREACHABLE', 'DISABLED')),
    CONSTRAINT ck_provider_connection_discovery
        CHECK (model_discovery IN ('remote-models', 'litellm-catalog', 'curated', 'manual')),
    CONSTRAINT uq_provider_connection_scope
        UNIQUE (owner_type, owner_id, provider_id)
);

CREATE INDEX idx_provider_connections_owner
    ON provider_connections(owner_type, owner_id, enabled);

CREATE INDEX idx_provider_connections_provider_status
    ON provider_connections(provider_id, status, enabled);

CREATE TABLE provider_credential_leases (
    id                       VARCHAR(36)  PRIMARY KEY,
    lease_hash               VARCHAR(128) NOT NULL UNIQUE,
    provider_connection_id   VARCHAR(36)  NOT NULL REFERENCES provider_connections(id) ON DELETE CASCADE,
    user_id                  VARCHAR(36)  NOT NULL,
    workspace_id             VARCHAR(36),
    session_id               VARCHAR(36),
    run_id                   VARCHAR(36),
    provider_id              VARCHAR(128) NOT NULL,
    model                    VARCHAR(255) NOT NULL,
    expires_at               TIMESTAMPTZ  NOT NULL,
    redeemed_at              TIMESTAMPTZ,
    revoked_at               TIMESTAMPTZ,
    created_at               TIMESTAMPTZ  NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_provider_credential_leases_expiry
    ON provider_credential_leases(expires_at);

CREATE INDEX idx_provider_credential_leases_binding
    ON provider_credential_leases(provider_connection_id, user_id, run_id);
