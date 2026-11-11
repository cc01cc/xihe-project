-- D-922 / task-152 F2: explicit, secret-free consumer/source audit for instance connections.
-- Management rows keep source = owner_type; every lease issued against an INSTANCE connection
-- writes one consumption row carrying consumer_user_id / consumer_workspace_id, so usage is
-- readable directly from this table instead of being inferred from provider_credential_lease.
ALTER TABLE provider_connection_audit ADD COLUMN source VARCHAR(16);
UPDATE provider_connection_audit SET source = owner_type;
ALTER TABLE provider_connection_audit ALTER COLUMN source SET NOT NULL;
ALTER TABLE provider_connection_audit ADD COLUMN consumer_user_id VARCHAR(64);
ALTER TABLE provider_connection_audit ADD COLUMN consumer_workspace_id VARCHAR(64);
