-- task-166 / D-1007 + D-1009 (2026-11-12): credentials gain the INSTANCE owner type.
--
-- D-1007 chose **A: extend the owner_type enum** over adding a second discriminator key
-- (scope). The reason is writability, not taste: two keys allow contradictory rows
-- (`owner_type=USER` + `scope=PLATFORM`) that every read path would silently treat as a user
-- resource. One key makes that class of row *unwritable*.
--
-- D-1009 fixed the instance row shape: `owner_type = 'INSTANCE'` and **no owner_id** (there is no
-- "instance owner" subject). This migration therefore (a) widens the enum, (b) drops NOT NULL on
-- owner_id, and (c) adds a pairing constraint so the only two legal shapes are
-- "INSTANCE + NULL owner_id" and "USER/WORKSPACE + NOT NULL owner_id". Without (c), dropping NOT
-- NULL would also legalise "USER + NULL owner_id", which is exactly the half-written row the
-- single-discriminator model exists to prevent.
--
-- No backfill (D-215): dev databases are cleared and rebuilt, so there are no pre-existing
-- instance rows to migrate. A production backfill would need a new ruling.
--
-- Rollback: ALTER TABLE credentials DROP CONSTRAINT ck_credentials_owner_pairing;
--           ALTER TABLE credentials ALTER COLUMN owner_id SET NOT NULL;   -- fails if INSTANCE rows exist
--           ALTER TABLE credentials DROP CONSTRAINT ck_credentials_owner_type;
--           ALTER TABLE credentials ADD CONSTRAINT ck_credentials_owner_type
--               CHECK (owner_type IN ('USER', 'WORKSPACE'));

ALTER TABLE credentials DROP CONSTRAINT ck_credentials_owner_type;
ALTER TABLE credentials ADD CONSTRAINT ck_credentials_owner_type
    CHECK (owner_type IN ('USER', 'WORKSPACE', 'INSTANCE'));

ALTER TABLE credentials ALTER COLUMN owner_id DROP NOT NULL;
ALTER TABLE credentials ADD CONSTRAINT ck_credentials_owner_pairing CHECK (
    (owner_type = 'INSTANCE' AND owner_id IS NULL)
    OR (owner_type <> 'INSTANCE' AND owner_id IS NOT NULL));

-- credential_events mirrors the credential's owner pair (CredentialService#recordEvent copies
-- both columns), so an INSTANCE lifecycle event would violate the old NOT NULL. The event table
-- never had an owner_type CHECK, and adding one here would reject any historical value, so only
-- the pairing rule is added: no null owner_id for a non-INSTANCE event, no non-null one for an
-- INSTANCE event.
ALTER TABLE credential_events ALTER COLUMN owner_id DROP NOT NULL;
ALTER TABLE credential_events ADD CONSTRAINT ck_credential_events_owner_pairing CHECK (
    (owner_type = 'INSTANCE' AND owner_id IS NULL)
    OR (owner_type <> 'INSTANCE' AND owner_id IS NOT NULL));
