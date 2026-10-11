-- PLAN-0438: immutable API Type + stable connectionKey for ProviderConnection.
-- Development-stage cutover: conflicting connection/lease/session pins are reset
-- rather than mapped to legacy wire behavior. Existing Flyway history is not rewritten.

ALTER TABLE provider_connections
    DROP CONSTRAINT IF EXISTS uq_provider_connection_scope;

DELETE FROM provider_connections;

UPDATE sessions
   SET provider_connection_id = NULL,
       connection_revision = NULL
 WHERE provider_connection_id IS NOT NULL;

UPDATE chat_runs
   SET provider_connection_id = NULL,
       connection_revision = NULL
 WHERE provider_connection_id IS NOT NULL;

DELETE FROM provider_connection_audit;

ALTER TABLE provider_connections
    ADD COLUMN connection_key VARCHAR(64),
    ADD COLUMN api_type_id VARCHAR(64),
    ADD COLUMN api_type_version INTEGER;

ALTER TABLE provider_connections
    ALTER COLUMN connection_key SET NOT NULL,
    ALTER COLUMN api_type_id SET NOT NULL,
    ALTER COLUMN api_type_version SET NOT NULL;

ALTER TABLE provider_connections
    ADD CONSTRAINT uq_provider_connections_owner_provider_key
        UNIQUE (owner_type, owner_id, provider_id, connection_key);
