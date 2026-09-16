-- =============================================================================
-- XH Control Plane — Run checkpoint slice state vocabulary (PLAN-0338)
--
-- The checkpoint projection moved from the interval model (base/end pairs) to the
-- slice model: one capture at the Run terminal transition, state vocabulary
-- captured | abnormal-captured | degraded | expired. The legacy table is reused
-- as-is until the PLAN-0339 slice-table rebuild; the only schema-level change
-- needed now is widening the V22 state allowlist so the new vocabulary is
-- writable (legacy values stay allowed for untouched pre-upgrade rows).
--
-- No data migration and no row cleanup here: PLAN-0338 decision #90 keeps the
-- destructive rebuild in PLAN-0339.
--
-- Rollback: restore the V22 allowlist (base, sealed, unsealed, degraded, expired);
--           rows already written with the new vocabulary must be removed first.
-- =============================================================================

ALTER TABLE run_checkpoints DROP CONSTRAINT ck_run_checkpoints_state;

ALTER TABLE run_checkpoints ADD CONSTRAINT ck_run_checkpoints_state
    CHECK (state IN ('base', 'sealed', 'unsealed', 'degraded', 'expired',
                     'captured', 'abnormal-captured'));
