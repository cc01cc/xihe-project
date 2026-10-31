-- PLAN-0610 T2.1 / T2.1a / T2.1b: V88 data copy into role bindings + narrowed grant sources.
--
-- This migration is the one-shot data window of the access-role switch. It is written for
-- PostgreSQL (Flyway only ever runs on PostgreSQL; the H2 unit profile disables Flyway, see
-- application-h2.properties). Everything below executes in a single Flyway transaction, so a
-- failure leaves the database at the V87 shape.
--
-- What it does, in order:
--   1. audit every legacy `grants.source='direct'` row (the retirement ledger; also mirrored in
--      plans/PLAN-0610-XH-dynamic-rbac/evidence/w2-migration.md);
--   2. create the initial bindings from the legacy facts:
--        users.role                  -> instance binding (ADMIN -> ADMIN, USER -> USER)
--        workspace_users.role         -> workspace binding (OWNER/ADMIN/MEMBER/EDITOR/VIEWER,
--                                        canonicalized exactly like WorkspaceRole.canonicalName)
--        workspaces.owner_id          -> WS_OWNER workspace binding (idempotent)
--   3. materialize every binding into `grants(source='role')` — one row per action atom,
--      capability atoms excluded (decision #23), scope copied from the binding (P0-1);
--   4. retire `grants.source='default'`:
--        subject_type='user'            -> the materialized `role` rows replace it (deleted below)
--        subject_type='agent'           -> `agent_default` (frozen snapshot, materializer never
--        subject_type='agent_principal'    overwrites it; P1-1)
--   5. retire `grants.source='direct'` (decision #21):
--        subject_type='agent_principal' -> `credential_binding` (the credential binding is the
--                                          second writer of this source; deleting the row would
--                                          break credential bindings)
--        subject_type IN ('user','agent')-> deleted (audited in step 1)
--   6. self-checks (zero row loss, binding union == materialized row set, no capability atoms,
--      no legacy sources left) — any violation raises and rolls the migration back;
--   7. narrow `ck_grants_source` to the five post-migration values and drop the V38/V65 legacy
--      partial indexes whose rows were converted above (round-2 R2-1).
--
-- Reversible: restore the V87 `ck_grants_source` (seven values) and recreate
-- `uq_grants_default_subject` / `uq_grants_direct_subject`; the retired rows are recorded in
-- `audit_logs` (action `authorization_direct_grant_retired`) and the V87 bindings/materialized
-- rows can be dropped by scope. A `pg_dump` backup is required before the maintenance window
-- (design §4 风险表).

-- ---------------------------------------------------------------------------
-- 1. Audit ledger for retired direct grants
--    One audit row per legacy row so the WHO/WHAT survives the delete. user_id is only set for
--    user subjects (FK to users); workspace_id stays NULL (legacy direct grants were
--    instance-wide by definition).
-- ---------------------------------------------------------------------------
INSERT INTO audit_logs (id, user_id, workspace_id, action, resource_type, resource_id, details, created_at)
SELECT gen_random_uuid(),
       CASE WHEN g.subject_type = 'user' THEN g.subject_id END,
       NULL,
       'authorization_direct_grant_retired',
       'grant',
       g.subject_id::TEXT,
       jsonb_build_object(
           'source', g.source,
           'subjectType', g.subject_type,
           'subjectId', g.subject_id,
           'permissions', g.permissions,
           'createdAt', g.created_at,
           'reason', 'PLAN-0610 V88: direct grant source retired',
           'replacement', CASE
               WHEN g.subject_type = 'agent_principal' THEN 'credential_binding'
               ELSE 'role binding (re-grant explicitly through access roles)'
           END
       )::TEXT,
       g.created_at
FROM grants g
WHERE g.source = 'direct';

-- ---------------------------------------------------------------------------
-- 2. Bindings from legacy facts
-- ---------------------------------------------------------------------------

-- 2a. users.role -> instance tier binding. A user that already has an instance-scope binding
--     (e.g. a database seeded by the W1a code) is left untouched: one tier binding per user.
INSERT INTO role_bindings (id, role_id, subject_type, subject_id, scope_type, scope_id, granted_by, granted_at)
SELECT gen_random_uuid(), r.id, 'user', u.id, 'instance', NULL, NULL, NOW()
FROM users u
JOIN roles r ON r.name = CASE WHEN u.role = 'ADMIN' THEN 'ADMIN' ELSE 'USER' END
WHERE NOT EXISTS (
    SELECT 1 FROM role_bindings b
    WHERE b.subject_type = 'user' AND b.subject_id = u.id AND b.scope_type = 'instance'
);

-- 2a-bis. instance_owner -> SUPER_ADMIN instance binding (design I5: the instance owner MUST hold
--        SUPER_ADMIN; pre-migration-audit §3.2). The owner keeps the ADMIN/USER tier binding from
--        2a as well — SUPER_ADMIN adds the two capability superset atoms, it does not replace the
--        tier grant.
INSERT INTO role_bindings (id, role_id, subject_type, subject_id, scope_type, scope_id, granted_by, granted_at)
SELECT gen_random_uuid(), r.id, 'user', io.owner_user_id, 'instance', NULL, NULL,
       COALESCE(io.assigned_at, NOW())
FROM instance_owner io
JOIN roles r ON r.name = 'SUPER_ADMIN'
WHERE io.owner_user_id IS NOT NULL
  AND NOT EXISTS (
      SELECT 1 FROM role_bindings b
      WHERE b.subject_type = 'user' AND b.subject_id = io.owner_user_id
        AND b.scope_type = 'instance' AND b.role_id = r.id
  );

-- 2b. workspace_users.role -> workspace binding. The five stored values map exactly like
--     WorkspaceRole.canonicalName(): OWNER -> WS_OWNER, VIEWER -> WS_VIEWER, everything else
--     (EDITOR / legacy ADMIN / legacy MEMBER) -> WS_EDITOR. Zero rows are dropped.
INSERT INTO role_bindings (id, role_id, subject_type, subject_id, scope_type, scope_id, granted_by, granted_at)
SELECT gen_random_uuid(), r.id, 'user', wu.user_id, 'workspace', wu.workspace_id, NULL, wu.created_at
FROM workspace_users wu
JOIN roles r ON r.name = CASE
        WHEN wu.role = 'OWNER' THEN 'WS_OWNER'
        WHEN wu.role = 'VIEWER' THEN 'WS_VIEWER'
        ELSE 'WS_EDITOR'
    END
WHERE NOT EXISTS (
    SELECT 1 FROM role_bindings b
    WHERE b.subject_type = 'user' AND b.subject_id = wu.user_id
      AND b.scope_type = 'workspace' AND b.scope_id = wu.workspace_id
);

-- 2c. workspaces.owner_id -> WS_OWNER workspace binding (the owner fact moves onto the binding;
--     V89 drops the column). Idempotent when 2b already produced the owner binding.
INSERT INTO role_bindings (id, role_id, subject_type, subject_id, scope_type, scope_id, granted_by, granted_at)
SELECT gen_random_uuid(), r.id, 'user', w.owner_id, 'workspace', w.id, NULL, COALESCE(w.created_at, NOW())
FROM workspaces w
JOIN roles r ON r.name = 'WS_OWNER'
WHERE NOT EXISTS (
    SELECT 1 FROM role_bindings b
    WHERE b.subject_type = 'user' AND b.subject_id = w.owner_id
      AND b.scope_type = 'workspace' AND b.scope_id = w.id
      AND b.role_id = r.id
);

-- ---------------------------------------------------------------------------
-- 3. Materialize the bindings into grants(source='role')
--    One row per action atom, matching RoleGrantMaterializer exactly:
--      permissions = [{"actionClass": <atom>}] (+ "resource" when the role pattern is not '*')
--      read_state = 'read', scope copied from the binding, granter NULL.
--    Capability atoms (they contain ':') are never materialized (decision #23). DISTINCT ON
--    collapses overlapping bindings (e.g. an instance owner holding ADMIN + SUPER_ADMIN) to one
--    row per (subject, scope, atom) — the unique index keys on the atom, and a plain
--    NOT EXISTS guard cannot see rows added earlier in the same statement.
-- ---------------------------------------------------------------------------
INSERT INTO grants (id, granter_type, granter_id, subject_type, subject_id, permissions, source,
                    scope_type, scope_id, read_state)
SELECT DISTINCT ON (b.subject_type, b.subject_id, b.scope_type, b.scope_id,
                    rp.action_class, rp.resource_pattern)
       gen_random_uuid(), NULL, NULL, b.subject_type, b.subject_id,
       jsonb_build_array(
           jsonb_build_object('actionClass', rp.action_class)
           || CASE WHEN rp.resource_pattern = '*'
                   THEN '{}'::jsonb
                   ELSE jsonb_build_object('resource', rp.resource_pattern) END
       ),
       'role', b.scope_type, b.scope_id, 'read'
FROM role_bindings b
JOIN role_permissions rp ON rp.role_id = b.role_id
WHERE rp.action_class NOT LIKE '%:%'
  AND NOT EXISTS (
      SELECT 1 FROM grants g
      WHERE g.source = 'role'
        AND g.subject_type = b.subject_type AND g.subject_id = b.subject_id
        AND g.scope_type = b.scope_type AND g.scope_id IS NOT DISTINCT FROM b.scope_id
        AND g.permissions -> 0 ->> 'actionClass' = rp.action_class
        AND COALESCE(g.permissions -> 0 ->> 'resource', '*') = rp.resource_pattern
  )
ORDER BY b.subject_type, b.subject_id, b.scope_type, b.scope_id,
         rp.action_class, rp.resource_pattern;

-- ---------------------------------------------------------------------------
-- 4. Retire source='default'
-- ---------------------------------------------------------------------------

-- 4a. Orphaned user defaults (subject no longer exists) are recorded before deletion; they have
--     no binding to be converted into.
INSERT INTO audit_logs (id, user_id, workspace_id, action, resource_type, resource_id, details, created_at)
SELECT gen_random_uuid(), NULL, NULL, 'authorization_default_grant_dropped_orphan', 'grant',
       g.subject_id::TEXT,
       jsonb_build_object('subjectType', g.subject_type, 'subjectId', g.subject_id,
                          'permissions', g.permissions,
                          'reason', 'subject no longer exists; nothing to bind')::TEXT,
       NOW()
FROM grants g
WHERE g.source = 'default' AND g.subject_type = 'user'
  AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id = g.subject_id);

-- 4b. User defaults are replaced by the materialized role rows (step 3).
DELETE FROM grants g
WHERE g.source = 'default' AND g.subject_type = 'user';

-- 4c. Agent/principal defaults become the frozen `agent_default` snapshot. When a frozen
--     snapshot already exists for the same subject (written by the W1a code), the legacy row is
--     dropped instead of colliding with uq_grants_agent_default_subject.
INSERT INTO audit_logs (id, user_id, workspace_id, action, resource_type, resource_id, details, created_at)
SELECT gen_random_uuid(), NULL, NULL, 'authorization_default_grant_dropped_duplicate', 'grant',
       g.subject_id::TEXT,
       jsonb_build_object('subjectType', g.subject_type, 'subjectId', g.subject_id,
                          'reason', 'agent_default snapshot already present')::TEXT,
       NOW()
FROM grants g
WHERE g.source = 'default' AND g.subject_type IN ('agent', 'agent_principal')
  AND EXISTS (
      SELECT 1 FROM grants f
      WHERE f.source = 'agent_default'
        AND f.subject_type = g.subject_type AND f.subject_id = g.subject_id
  );

DELETE FROM grants g
WHERE g.source = 'default' AND g.subject_type IN ('agent', 'agent_principal')
  AND EXISTS (
      SELECT 1 FROM grants f
      WHERE f.source = 'agent_default'
        AND f.subject_type = g.subject_type AND f.subject_id = g.subject_id
  );

UPDATE grants
SET source = 'agent_default'
WHERE source = 'default' AND subject_type IN ('agent', 'agent_principal');

-- ---------------------------------------------------------------------------
-- 5. Retire source='direct' (decision #21)
-- ---------------------------------------------------------------------------

-- 5a. Credential bindings: rename where the row is the subject's only binding (V65 semantics
--     preserved by uq_grants_credential_binding_subject). A conflicting row means the W1a
--     writer already produced the credential binding; that row wins and the legacy copy was
--     audited in step 1.
UPDATE grants g
SET source = 'credential_binding'
WHERE g.source = 'direct' AND g.subject_type = 'agent_principal'
  AND NOT EXISTS (
      SELECT 1 FROM grants f
      WHERE f.source = 'credential_binding'
        AND f.subject_type = g.subject_type AND f.subject_id = g.subject_id
  );

DELETE FROM grants g
WHERE g.source = 'direct' AND g.subject_type = 'agent_principal';

-- 5b. User and agent-session direct grants are retired; step 1 already wrote the audit ledger.
DELETE FROM grants g
WHERE g.source = 'direct' AND g.subject_type IN ('user', 'agent');

-- ---------------------------------------------------------------------------
-- 6. Self-checks: fail closed instead of silently producing a half-migrated instance.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    missing INTEGER;
BEGIN
    -- 6.1 every user has an instance binding, at most one ADMIN/USER tier binding, and the
    --     instance owner holds SUPER_ADMIN (design I5). The owner's SUPER_ADMIN binding is
    --     additional to the tier binding, so the tier count stays one.
    SELECT count(*) INTO missing
    FROM users u
    WHERE NOT EXISTS (SELECT 1 FROM role_bindings b
                      WHERE b.subject_type = 'user' AND b.subject_id = u.id
                        AND b.scope_type = 'instance');
    IF missing <> 0 THEN
        RAISE EXCEPTION 'V88: % user(s) without an instance binding', missing;
    END IF;

    SELECT count(*) INTO missing
    FROM users u
    WHERE (SELECT count(*) FROM role_bindings b JOIN roles r ON r.id = b.role_id
           WHERE b.subject_type = 'user' AND b.subject_id = u.id
             AND b.scope_type = 'instance' AND r.name IN ('ADMIN', 'USER')) > 1;
    IF missing <> 0 THEN
        RAISE EXCEPTION 'V88: % user(s) with more than one ADMIN/USER tier binding', missing;
    END IF;

    SELECT count(*) INTO missing
    FROM instance_owner io
    WHERE io.owner_user_id IS NOT NULL
      AND NOT EXISTS (
          SELECT 1 FROM role_bindings b JOIN roles r ON r.id = b.role_id
          WHERE b.subject_type = 'user' AND b.subject_id = io.owner_user_id
            AND b.scope_type = 'instance' AND r.name = 'SUPER_ADMIN'
      );
    IF missing <> 0 THEN
        RAISE EXCEPTION 'V88: % instance owner(s) without the SUPER_ADMIN binding', missing;
    END IF;

    -- 6.2 zero workspace_users rows lost: each row has the mapped workspace binding
    SELECT count(*) INTO missing
    FROM workspace_users wu
    WHERE NOT EXISTS (
        SELECT 1 FROM role_bindings b
        JOIN roles r ON r.id = b.role_id
        WHERE b.subject_type = 'user' AND b.subject_id = wu.user_id
          AND b.scope_type = 'workspace' AND b.scope_id = wu.workspace_id
          AND r.name = CASE WHEN wu.role = 'OWNER' THEN 'WS_OWNER'
                            WHEN wu.role = 'VIEWER' THEN 'WS_VIEWER'
                            ELSE 'WS_EDITOR' END
    );
    IF missing <> 0 THEN
        RAISE EXCEPTION 'V88: % workspace_users row(s) without the mapped binding', missing;
    END IF;

    -- 6.3 every workspace owner has the WS_OWNER binding
    SELECT count(*) INTO missing
    FROM workspaces w
    WHERE NOT EXISTS (
        SELECT 1 FROM role_bindings b
        JOIN roles r ON r.id = b.role_id
        WHERE b.subject_type = 'user' AND b.subject_id = w.owner_id
          AND b.scope_type = 'workspace' AND b.scope_id = w.id AND r.name = 'WS_OWNER'
    );
    IF missing <> 0 THEN
        RAISE EXCEPTION 'V88: % workspace(s) without the owner binding', missing;
    END IF;

    -- 6.4 binding union == materialized row set (user subjects; round-2 R2-2)
    SELECT count(*) INTO missing
    FROM role_bindings b
    JOIN role_permissions rp ON rp.role_id = b.role_id
    WHERE b.subject_type = 'user' AND rp.action_class NOT LIKE '%:%'
      AND NOT EXISTS (
          SELECT 1 FROM grants g
          WHERE g.source = 'role'
            AND g.subject_type = b.subject_type AND g.subject_id = b.subject_id
            AND g.scope_type = b.scope_type AND g.scope_id IS NOT DISTINCT FROM b.scope_id
            AND g.permissions -> 0 ->> 'actionClass' = rp.action_class
            AND COALESCE(g.permissions -> 0 ->> 'resource', '*') = rp.resource_pattern
      );
    IF missing <> 0 THEN
        RAISE EXCEPTION 'V88: % user binding atom(s) missing from grants', missing;
    END IF;

    -- 6.5 no stale role rows: every source='role' row is backed by a current binding atom
    SELECT count(*) INTO missing
    FROM grants g
    WHERE g.source = 'role'
      AND NOT EXISTS (
          SELECT 1 FROM role_bindings b
          JOIN role_permissions rp ON rp.role_id = b.role_id
          WHERE b.subject_type = g.subject_type AND b.subject_id = g.subject_id
            AND b.scope_type = g.scope_type AND b.scope_id IS NOT DISTINCT FROM g.scope_id
            AND rp.action_class = g.permissions -> 0 ->> 'actionClass'
            AND rp.resource_pattern = COALESCE(g.permissions -> 0 ->> 'resource', '*')
      );
    IF missing <> 0 THEN
        RAISE EXCEPTION 'V88: % materialized row(s) have no backing binding atom', missing;
    END IF;

    -- 6.6 capability atoms never reach grants (decision #23)
    SELECT count(*) INTO missing FROM grants WHERE permissions -> 0 ->> 'actionClass' LIKE '%:%';
    IF missing <> 0 THEN
        RAISE EXCEPTION 'V88: % capability atom(s) materialized into grants', missing;
    END IF;

    -- 6.7 no retired sources left
    SELECT count(*) INTO missing FROM grants WHERE source IN ('default', 'direct');
    IF missing <> 0 THEN
        RAISE EXCEPTION 'V88: % legacy-source grant row(s) left', missing;
    END IF;

    -- 6.8 no unknown subject type slipped through the direct retirement branches
    SELECT count(*) INTO missing FROM grants
    WHERE source = 'direct' AND subject_type NOT IN ('user', 'agent', 'agent_principal');
    IF missing <> 0 THEN
        RAISE EXCEPTION 'V88: % direct row(s) with an unexpected subject type', missing;
    END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 7. Narrow the source allow-list + drop the legacy fences whose rows are gone
-- ---------------------------------------------------------------------------
ALTER TABLE grants DROP CONSTRAINT ck_grants_source;
ALTER TABLE grants ADD CONSTRAINT ck_grants_source
    CHECK (source IN ('role', 'spawn', 'template', 'credential_binding', 'agent_default'));

DROP INDEX IF EXISTS uq_grants_default_subject;
DROP INDEX IF EXISTS uq_grants_direct_subject;
