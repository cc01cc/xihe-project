-- D-922 / task-152: INSTANCE provider connection scope (instance-shared defaults).
-- The V1 check only allowed SYSTEM/WORKSPACE/USER; INSTANCE rows are written exclusively by
-- cap:instance:admin holders and consumed by every profile resolution as the last fallback.
ALTER TABLE provider_connections DROP CONSTRAINT ck_provider_connection_owner_type;
ALTER TABLE provider_connections ADD CONSTRAINT ck_provider_connection_owner_type
    CHECK (owner_type IN ('SYSTEM', 'WORKSPACE', 'USER', 'INSTANCE'));
