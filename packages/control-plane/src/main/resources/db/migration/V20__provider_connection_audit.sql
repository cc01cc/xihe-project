CREATE TABLE provider_connection_audit (
    id                       VARCHAR(36)  PRIMARY KEY,
    provider_connection_id   VARCHAR(36),
    owner_type               VARCHAR(16)  NOT NULL,
    owner_id                 VARCHAR(64)  NOT NULL,
    provider_id              VARCHAR(128) NOT NULL,
    action                   VARCHAR(32)  NOT NULL,
    changed_by               VARCHAR(64)  NOT NULL,
    from_status              VARCHAR(32),
    to_status                VARCHAR(32),
    credential_present       BOOLEAN      NOT NULL DEFAULT FALSE,
    credential_last4         VARCHAR(4),
    connection_revision      BIGINT       NOT NULL,
    created_at               TIMESTAMPTZ  NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_provider_connection_audit_connection
    ON provider_connection_audit(provider_connection_id, created_at);

CREATE INDEX idx_provider_connection_audit_owner
    ON provider_connection_audit(owner_type, owner_id, created_at);
