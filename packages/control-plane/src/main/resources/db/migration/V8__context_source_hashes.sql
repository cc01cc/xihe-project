CREATE TABLE context_source_hashes (
    id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id  VARCHAR(36)  NOT NULL,
    source_key    VARCHAR(255) NOT NULL,
    hash          VARCHAR(64)  NOT NULL,
    created_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (workspace_id, source_key)
);

CREATE INDEX idx_context_source_hashes_workspace_id ON context_source_hashes(workspace_id);
CREATE INDEX idx_context_source_hashes_source_key ON context_source_hashes(source_key);
