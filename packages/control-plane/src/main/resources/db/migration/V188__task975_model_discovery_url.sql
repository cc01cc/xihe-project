-- task-975 / R17 (D-206): connection-level model discovery URL.
-- Only consulted when model_discovery = 'remote-models'; NULL means `{base_url}/models`.
-- No backfill: XH has no production data yet (D-215), so existing rows legitimately read NULL.

ALTER TABLE provider_connections
    ADD COLUMN model_discovery_url VARCHAR(2048);

COMMENT ON COLUMN provider_connections.model_discovery_url IS
    'Optional absolute http(s) model-list URL; NULL falls back to {base_url}/models. Only used when model_discovery = remote-models.';
