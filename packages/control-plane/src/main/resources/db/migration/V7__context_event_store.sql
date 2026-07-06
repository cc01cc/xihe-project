CREATE TABLE context_events (
    id             UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id     VARCHAR(36)  NOT NULL REFERENCES sessions(id),
    workspace_id   VARCHAR(36)  NOT NULL,
    user_id        VARCHAR(36)  NOT NULL,
    event_type     VARCHAR(50)  NOT NULL,
    sequence       BIGINT       NOT NULL,
    payload        JSONB        NOT NULL DEFAULT '{}',
    correlation_id VARCHAR(36),
    causation_id   VARCHAR(36),
    created_at     TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (session_id, sequence)
);

CREATE TABLE context_projections (
    id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id      VARCHAR(36)  NOT NULL UNIQUE REFERENCES sessions(id),
    workspace_id    VARCHAR(36)  NOT NULL,
    user_id         VARCHAR(36)  NOT NULL,
    projection_type VARCHAR(50)  NOT NULL DEFAULT 'agent_context',
    latest_sequence BIGINT       NOT NULL DEFAULT 0,
    payload         JSONB        NOT NULL DEFAULT '{}',
    created_at      TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_context_events_session_id ON context_events(session_id);
CREATE INDEX idx_context_events_session_sequence ON context_events(session_id, sequence);
CREATE INDEX idx_context_events_workspace_id ON context_events(workspace_id);
CREATE INDEX idx_context_events_event_type ON context_events(event_type);
CREATE INDEX idx_context_projections_session_id ON context_projections(session_id);
CREATE INDEX idx_context_projections_workspace_id ON context_projections(workspace_id);
