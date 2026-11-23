-- task-933: inverse of V186__task933_preset_as_template.sql.
--
-- Restores the PRE-R39 world exactly: the automatic per-edit reconcile lives again (the Java
-- side is on the branch that ships this file), the historical value comes back, the backfilled
-- provenance is dropped with the column, and the partial unique key returns to the definition V87
-- wrote and V182 never rebuilt: predicate {@code source = 'role'}. That predicate matches no row
-- once the values say 'preset', so the index is DEAD — which IS the pre-UP state (V186's header
-- documents the key as dead since V182).
--
-- Rebuilding it on 'preset' instead would be wrong twice over: it would not be the pre-UP state,
-- and it would go LIVE, then fail outright with "could not create unique index" on any subject that
-- imported the same atom from two presets — a shape V186 deliberately permits (origin_preset_id is
-- in the key), so a rollback of a real database would abort. Measured on PostgreSQL 17.
--
-- Idempotent by construction: DROP ... IF EXISTS and the value conversion only touches rows
-- this migration introduced. A retried rollback is therefore safe.

ALTER TABLE grants DROP CONSTRAINT IF EXISTS ck_grants_source;
UPDATE grants SET source = 'preset' WHERE source = 'assigned';
ALTER TABLE grants ADD CONSTRAINT ck_grants_source
    CHECK (source IN ('preset', 'spawn', 'template', 'credential_binding', 'agent_default',
                      'plugin_binding'));

DROP INDEX IF EXISTS uq_grants_role_atom;
CREATE UNIQUE INDEX uq_grants_role_atom
    ON grants (subject_type, subject_id, scope_type, scope_id,
               (permissions -> 0 ->> 'actionClass'),
               (COALESCE(permissions -> 0 ->> 'resource', '*')))
    NULLS NOT DISTINCT
    WHERE source = 'role';

ALTER TABLE grants DROP COLUMN IF EXISTS origin_preset_id;
