-- =============================================================================
-- XH Control Plane — Schema gate fixes (PLAN-280, M1 hardening)
--
-- Makes every V1 FK explicitly declare ON DELETE (preserving the previous
-- implicit NO ACTION semantics), drops indexes that duplicate UNIQUE
-- constraints, and adds config.created_at for entity/spec parity.
--
-- Conventions follow V1__init_schema.sql (PLAN-280):
--   * PostgreSQL native UUID ids, TIMESTAMPTZ time columns, NOW() defaults.
--   * Every FK is explicitly named and declares ON DELETE.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Explicit ON DELETE NO ACTION for user-owned FKs that previously relied on
-- the implicit PostgreSQL default. Semantics are unchanged; only the DDL is
-- now explicit per PLAN-280 Decision 18 gate.
-- -----------------------------------------------------------------------------

ALTER TABLE workspaces
    DROP CONSTRAINT fk_workspaces_owner,
    ADD CONSTRAINT fk_workspaces_owner FOREIGN KEY (owner_id) REFERENCES users (id) ON DELETE NO ACTION;

ALTER TABLE sessions
    DROP CONSTRAINT fk_sessions_user,
    ADD CONSTRAINT fk_sessions_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE NO ACTION;

ALTER TABLE chat_runs
    DROP CONSTRAINT fk_chat_runs_user,
    ADD CONSTRAINT fk_chat_runs_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE NO ACTION;

ALTER TABLE files
    DROP CONSTRAINT fk_files_user,
    ADD CONSTRAINT fk_files_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE NO ACTION;

ALTER TABLE context_events
    DROP CONSTRAINT fk_context_events_user,
    ADD CONSTRAINT fk_context_events_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE NO ACTION;

ALTER TABLE context_projections
    DROP CONSTRAINT fk_context_projections_user,
    ADD CONSTRAINT fk_context_projections_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE NO ACTION;

ALTER TABLE approval_requests
    DROP CONSTRAINT fk_approval_requests_user,
    ADD CONSTRAINT fk_approval_requests_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE NO ACTION;

-- -----------------------------------------------------------------------------
-- Drop indexes duplicated by UNIQUE constraints. The UNIQUE-backed indexes
-- already support the same prefix lookups; the extra indexes only add write
-- amplification and maintenance cost.
-- -----------------------------------------------------------------------------

DROP INDEX IF EXISTS idx_workspace_execution_specs_workspace_generation;
DROP INDEX IF EXISTS idx_context_events_session_sequence;
DROP INDEX IF EXISTS idx_config_lookup;

-- -----------------------------------------------------------------------------
-- config.created_at for entity/spec parity (PLAN-280 Issue 7).
-- Existing rows get NOW() via the column default; the JPA entity maps the
-- same column as non-updatable.
-- -----------------------------------------------------------------------------

ALTER TABLE config
    ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
