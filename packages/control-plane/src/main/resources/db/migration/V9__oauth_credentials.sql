CREATE TABLE oauth_credentials (
    id                       VARCHAR(36)  PRIMARY KEY,
    user_id                  VARCHAR(36)  NOT NULL REFERENCES users(id),
    workspace_id             VARCHAR(36)  NOT NULL REFERENCES workspaces(id),
    server_id                VARCHAR(36)  NOT NULL REFERENCES mcp_servers(id),
    client_id                VARCHAR(255) NOT NULL,
    token_endpoint            VARCHAR(512) NOT NULL,
    redirect_uri              VARCHAR(512) NOT NULL,
    scope                    VARCHAR(1024) NOT NULL,
    refresh_token_ciphertext  TEXT         NOT NULL,
    encryption_key_version    VARCHAR(32)  NOT NULL,
    status                    VARCHAR(32)  NOT NULL DEFAULT 'AUTHORIZED',
    created_at                TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at                TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_oauth_credential_binding UNIQUE (user_id, workspace_id, server_id)
);

CREATE INDEX idx_oauth_credentials_workspace ON oauth_credentials(workspace_id);
CREATE INDEX idx_oauth_credentials_server ON oauth_credentials(server_id);
