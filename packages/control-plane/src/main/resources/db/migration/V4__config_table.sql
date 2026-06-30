CREATE TABLE IF NOT EXISTS config (
    id            BIGSERIAL PRIMARY KEY,
    environment   VARCHAR(32) NOT NULL DEFAULT 'default',
    layer         VARCHAR(16) NOT NULL,
    domain        VARCHAR(32) NOT NULL,
    config_key    VARCHAR(64) NOT NULL,
    config_value  TEXT,
    is_set        BOOLEAN NOT NULL DEFAULT TRUE,
    updated_by    VARCHAR(64),
    updated_at    TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE (environment, layer, domain, config_key)
);

CREATE TABLE IF NOT EXISTS config_audit (
    id              BIGSERIAL PRIMARY KEY,
    config_id       BIGINT NOT NULL REFERENCES config(id),
    environment     VARCHAR(32),
    layer           VARCHAR(16),
    domain          VARCHAR(32),
    config_key      VARCHAR(64),
    old_value       TEXT,
    new_value       TEXT,
    changed_by      VARCHAR(64),
    changed_at      TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_config_lookup
    ON config (environment, layer, domain);

CREATE INDEX IF NOT EXISTS idx_config_audit_config_id
    ON config_audit (config_id);
