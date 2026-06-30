CREATE TABLE users (
    id          VARCHAR(36)  PRIMARY KEY,
    email       VARCHAR(255) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    role        VARCHAR(20)  NOT NULL DEFAULT 'USER',
    name        VARCHAR(100),
    avatar      VARCHAR(512),
    settings    TEXT,
    created_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE workspaces (
    id          VARCHAR(36)  PRIMARY KEY,
    name        VARCHAR(255) NOT NULL,
    description TEXT,
    owner_id    VARCHAR(36)  NOT NULL REFERENCES users(id),
    settings    TEXT,
    created_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE workspace_users (
    workspace_id VARCHAR(36) NOT NULL REFERENCES workspaces(id),
    user_id      VARCHAR(36) NOT NULL REFERENCES users(id),
    role         VARCHAR(20) NOT NULL DEFAULT 'MEMBER',
    created_at   TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (workspace_id, user_id)
);

CREATE TABLE sessions (
    id             VARCHAR(36)  PRIMARY KEY,
    workspace_id   VARCHAR(36)  NOT NULL REFERENCES workspaces(id),
    user_id        VARCHAR(36)  NOT NULL REFERENCES users(id),
    title          VARCHAR(255),
    model_provider VARCHAR(50),
    model_name     VARCHAR(100),
    archived       BOOLEAN      NOT NULL DEFAULT FALSE,
    created_at     TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at     TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE messages (
    id         VARCHAR(36) PRIMARY KEY,
    session_id VARCHAR(36) NOT NULL REFERENCES sessions(id),
    role       VARCHAR(20) NOT NULL,
    content    TEXT        NOT NULL,
    metadata   TEXT,
    created_at TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE files (
    id           VARCHAR(36)  PRIMARY KEY,
    user_id      VARCHAR(36)  NOT NULL REFERENCES users(id),
    workspace_id VARCHAR(36)  REFERENCES workspaces(id),
    filename     VARCHAR(255) NOT NULL,
    mime_type    VARCHAR(127),
    size_bytes   BIGINT       NOT NULL DEFAULT 0,
    storage_path VARCHAR(512) NOT NULL,
    created_at   TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE mcp_servers (
    id           VARCHAR(36)  PRIMARY KEY,
    workspace_id VARCHAR(36)  NOT NULL REFERENCES workspaces(id),
    name         VARCHAR(255) NOT NULL,
    endpoint     VARCHAR(512) NOT NULL,
    auth_config  TEXT,
    enabled      BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at   TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at   TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE audit_logs (
    id            VARCHAR(36)  PRIMARY KEY,
    user_id       VARCHAR(36)  REFERENCES users(id),
    workspace_id  VARCHAR(36)  REFERENCES workspaces(id),
    action        VARCHAR(100) NOT NULL,
    resource_type VARCHAR(50),
    resource_id   VARCHAR(36),
    details       TEXT,
    created_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_workspaces_owner_id ON workspaces(owner_id);
CREATE INDEX idx_workspace_users_user_id ON workspace_users(user_id);
CREATE INDEX idx_sessions_workspace_id ON sessions(workspace_id);
CREATE INDEX idx_sessions_user_id ON sessions(user_id);
CREATE INDEX idx_sessions_archived ON sessions(archived);
CREATE INDEX idx_messages_session_id ON messages(session_id);
CREATE INDEX idx_files_user_id ON files(user_id);
CREATE INDEX idx_files_workspace_id ON files(workspace_id);
CREATE INDEX idx_mcp_servers_workspace_id ON mcp_servers(workspace_id);
CREATE INDEX idx_audit_logs_user_id ON audit_logs(user_id);
CREATE INDEX idx_audit_logs_workspace_id ON audit_logs(workspace_id);
CREATE INDEX idx_audit_logs_action ON audit_logs(action);
