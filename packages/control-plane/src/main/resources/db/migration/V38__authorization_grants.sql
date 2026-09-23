-- PLAN-0407 T1.2: one extensible grant store for principal permissions.

CREATE TABLE grants (
    id            UUID PRIMARY KEY,
    granter_type  VARCHAR(24),
    granter_id    UUID,
    subject_type  VARCHAR(24) NOT NULL,
    subject_id    UUID NOT NULL,
    permissions   JSONB NOT NULL,
    source        VARCHAR(16) NOT NULL,
    role_name     TEXT,
    template_name TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    read_state    VARCHAR(16) NOT NULL DEFAULT 'unread',
    CONSTRAINT ck_grants_granter_ref CHECK ((granter_type IS NULL) = (granter_id IS NULL)),
    CONSTRAINT ck_grants_source CHECK (source IN ('default', 'spawn', 'direct', 'template')),
    CONSTRAINT ck_grants_read_state CHECK (read_state IN ('unread', 'read'))
);

CREATE INDEX idx_grants_subject ON grants (subject_type, subject_id);

CREATE UNIQUE INDEX uq_grants_default_subject
    ON grants (subject_type, subject_id)
    WHERE source = 'default';
