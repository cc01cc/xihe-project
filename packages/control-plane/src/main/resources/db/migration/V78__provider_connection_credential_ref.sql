-- PLAN-0553: hard cut provider connection credentials to the credential domain.
-- A: add the owner-neutral reference, invalidate every legacy key-bearing row,
-- then drop the legacy ciphertext columns in the same version. No backfill, no
-- dual read, no dual write. Recovery is the pre-V78 database backup.
ALTER TABLE provider_connections
    ADD COLUMN credential_id UUID NULL;

ALTER TABLE provider_connections
    ADD CONSTRAINT fk_provider_connections_credential
    FOREIGN KEY (credential_id) REFERENCES credentials(id) ON DELETE RESTRICT;

CREATE INDEX idx_provider_connections_credential
    ON provider_connections (credential_id);

UPDATE provider_connections
   SET status = 'UNVERIFIED',
       revision = revision + 1,
       last_verified_at = NULL,
       last_error_code = NULL
 WHERE credential_ciphertext IS NOT NULL;

ALTER TABLE provider_connections
    DROP COLUMN credential_ciphertext;

ALTER TABLE provider_connections
    DROP COLUMN encryption_key_version;
