-- PLAN-0610 W4b / V89: drop the legacy role columns and the membership table.
--
-- The access-role model is the only authorization fact from W3 on: `role_bindings` (role x subject x
-- scope) plus the materialized `grants(source='role')` rows. V87 created the catalog, V88 copied every
-- legacy fact into bindings and self-checked that nothing was lost, W3-2a exposed the binding API,
-- W3-3 made every membership reader use the binding seam, and W4a stopped reading/writing
-- `users.role`. What remains below is dead weight:
--
--   users.role          -> instance tier binding (V88: ADMIN -> ADMIN, USER -> USER; the bootstrap
--                          SUPER_ADMIN is owned by instance ownership since W1c)
--   workspaces.owner_id -> `WS_OWNER` workspace binding (V88 2c; idempotent, earliest binding wins
--                          when a workspace was handed over)
--   workspace_users     -> `WS_OWNER`/`WS_EDITOR`/`WS_VIEWER` workspace bindings (V88 2b)
--
-- W4b removed the last code dependency on all three (seam fallback, transitional mirror, owner column
-- reads, and the 67 fixture writes moved to `WorkspaceFixture`), so this migration is purely
-- destructive. It is intentionally idempotent (`IF EXISTS`) so a partially migrated development
-- database can be re-run, and it does not touch any row of `role_bindings`/`grants`.
--
-- Invariants checked before the drop (fail-closed: the migration raises and rolls back if violated):
--   * no workspace would be left without a `WS_OWNER` binding after `owner_id` disappears
--     (otherwise the derived `ownerId` wire field and every owner-only write would lose their subject);
--   * no user row depends on the `ck_users_role` constraint value (the column is gone afterwards).

-- 1. Pre-flight: every live workspace must still have an owner binding. V88 2c created it from
--    workspaces.owner_id; a workspace created after V88 got its binding from the W3-3 creation path.
DO $$
DECLARE
    missing INTEGER;
BEGIN
    SELECT count(*) INTO missing
    FROM workspaces w
    WHERE w.deleted_at IS NULL
      AND NOT EXISTS (
          SELECT 1
          FROM role_bindings b
          JOIN roles r ON r.id = b.role_id
          WHERE b.scope_type = 'workspace'
            AND b.scope_id = w.id
            AND b.subject_type = 'user'
            AND r.name = 'WS_OWNER');
    IF missing > 0 THEN
        RAISE EXCEPTION 'V89: % active workspace(s) have no WS_OWNER binding; the access-role '
            'migration (V88) or the W3-3 creation path did not complete', missing;
    END IF;
END $$;

-- 2. workspaces.owner_id: drop the owner partial indexes, the FK, then the column.
DROP INDEX IF EXISTS idx_workspaces_active_owner;
DROP INDEX IF EXISTS idx_workspaces_owner_active;
-- uq_workspaces_create_idempotency also covers owner_id; recreate it on the key alone (the create
-- path resolves idempotency by key and then checks the caller's WS_OWNER binding, see
-- WorkspaceService.createWorkspaceLocked / WorkspaceRepository.findByCreateIdempotencyKeyAndDeletedAtIsNull).
DROP INDEX IF EXISTS uq_workspaces_create_idempotency;
ALTER TABLE workspaces DROP CONSTRAINT IF EXISTS fk_workspaces_owner;
ALTER TABLE workspaces DROP COLUMN IF EXISTS owner_id;
CREATE UNIQUE INDEX IF NOT EXISTS uq_workspaces_create_idempotency
    ON workspaces (create_idempotency_key)
    WHERE deleted_at IS NULL AND create_idempotency_key IS NOT NULL;

-- 3. workspace_users: the membership table itself (its PK, FKs and index go with it).
DROP TABLE IF EXISTS workspace_users;

-- 4. users.role: the CHECK first, then the column.
ALTER TABLE users DROP CONSTRAINT IF EXISTS ck_users_role;
ALTER TABLE users DROP COLUMN IF EXISTS role;
