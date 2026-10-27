-- PLAN-0556: administrator config locks (global; one row per domain+key).
--
-- A2 semantics (2026-10-27): the enforced value lives in the existing
-- instance-layer config row. This table records only the lock decision, its
-- reason and the last actor, so the value keeps a single home and unlocking
-- leaves an ordinary instance default behind.
--
-- No secret material, no scope columns (v1 is a global lock), no soft delete
-- (unlock deletes the row; history lives in audit_logs).

CREATE TABLE config_locks (
    id          UUID          PRIMARY KEY,
    domain      VARCHAR(32)   NOT NULL,
    config_key  VARCHAR(64)   NOT NULL,
    mode        VARCHAR(16)   NOT NULL,
    reason      VARCHAR(200)  NOT NULL,
    updated_by  VARCHAR(64)   NOT NULL,
    updated_at  TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_config_locks_key UNIQUE (domain, config_key),
    CONSTRAINT ck_config_locks_mode CHECK (mode IN ('enforce_value', 'write_guard'))
);

CREATE INDEX idx_config_locks_domain ON config_locks (domain);
