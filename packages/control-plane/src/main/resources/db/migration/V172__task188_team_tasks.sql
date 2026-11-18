-- V172 (task-188 MVP⑤ S2): the shared team-task board — table + TEAM_TASK_MANAGE atom seeds.
--
-- Number allocation (checks at implementation time, 2026-11-18): develop tree max = V171;
-- 'git log --all --diff-filter=A -- <dir>/V172* <dir>/V173*' = 0 hits;
-- 'git worktree list' = this checkout only. => V172 (+V173 reserved for S3 in the same lane's
-- registration), not a guess. Registered in internal/A03-xihe/docs/migration-numbers.md §0/§4.
--
-- Shape authority: task-188 design §4.2 (team-task-B 锚定 DSH 语义) + D-1821 默认②④⑤:
--   - one board per team, keyed by the tree's root session (team_root_session_id). The tree is
--     established by DelegationChainWalker the moment a row is written, so no open FK to
--     sessions: a task's root is recomputed on read, and a pre-tree row's root IS itself.
--   - task numbering is per-board atomic sequence (task_no), displayed as task-<n>; NOT the DSH
--     global id — one less cross-repo coupling.
--   - lifecycle is advisory CAS: status pending/in_progress/completed/deleted, transition CAS on
--     (expectedRevision) only; claims have no lease/expiry (bl-354 guard: no leased claim shape).
--   - blocked_by / write_scopes are advisory (never gate transitions). write_scope_warnings is
--     DERIVED at read time by TeamTaskService — not stored.
--   - reassign is spawn lineage, not a claim: owner_session_id may name any descendant session of
--     the board root; TeamTaskService walks the tree to prove it.
--
-- Default grant set (D-1821 默认⑤): USER (human owner commands the board by default — the atom
-- sits in BASE_ATOMS in SystemAccessRoleCatalog, so AGENT_USER inherits it for the teammate
-- claim/complete path, and ADMIN inherits it via its concat of USER_DEFAULT_ATOMS — the
-- established inheritance, not an extra privilege), AGENT_USER (the teammate is an agent
-- principal; claiming/completing is its job), WS_OWNER + WS_EDITOR (workspace-domain action).
-- WS_VIEWER stays out. SUPER_ADMIN rows are the mirror mandate of DefaultSetMigrationParityTest
-- (a code-side atom without its seed row leaves SUPER_ADMIN one atom short).
-- The atom is deliberately NOT in AGENT_FORBIDDEN_ATOMS (MANAGE_SKILL_LIBRARY N5-N9 precedent).

-- ---------------------------------------------------------------------------------------------
-- 1) The table.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE team_tasks (
    id                       uuid PRIMARY KEY,
    -- task_no / revision are Java long: bigint, not integer (Hibernate validates the mapped
    -- type, so integer columns fail context startup — measured).
    task_no                  bigint       NOT NULL,
    subject                  varchar(200) NOT NULL,
    description              text,
    status                   varchar(16)  NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'in_progress', 'completed', 'deleted')),
    -- Every id column is a native UUID (the canonical schema convention, PLAN-280): the entity
    -- maps them to Java String through UuidStringConverter, and Hibernate's schema validation
    -- compares against the CONVERTED type — a varchar(36) column here fails context startup
    -- ("wrong column type encountered ... expecting uuid"), measured the hard way.
    owner_session_id         uuid,
    owner_name               varchar(64),
    blocked_by               jsonb        NOT NULL DEFAULT '[]'::jsonb,
    write_scopes             jsonb        NOT NULL DEFAULT '[]'::jsonb,
    created_by_session_id    uuid         NOT NULL,
    created_by_participant_id uuid,
    team_root_session_id     uuid         NOT NULL,
    workspace_id             uuid         NOT NULL,
    revision                 bigint       NOT NULL DEFAULT 0,
    created_at               timestamptz  NOT NULL DEFAULT now(),
    updated_at               timestamptz  NOT NULL DEFAULT now(),
    -- one board per team: (root session, task number) is the display identity (task-<n>)
    CONSTRAINT uq_team_tasks_board_no UNIQUE (team_root_session_id, task_no)
);

CREATE INDEX idx_team_tasks_board ON team_tasks (team_root_session_id, created_at, task_no);
CREATE INDEX idx_team_tasks_owner ON team_tasks (owner_session_id) WHERE owner_session_id IS NOT NULL;

COMMENT ON TABLE  team_tasks IS 'task-188 MVP⑤ shared team-task board: one board per tree (root session); advisory CAS lifecycle, no leased claims (bl-354)';
COMMENT ON COLUMN team_tasks.team_root_session_id IS 'the tree root session that owns the board; recomputed on every read by DelegationChainWalker — the stored value is the write-time snapshot';
COMMENT ON COLUMN team_tasks.revision IS 'advisory CAS revision: monotonic +1 on every successful mutation; readers see it but never gate on it';

-- ---------------------------------------------------------------------------------------------
-- 2) Role seeds (6 rows). Form copied from V157:35-44: idempotent ON CONFLICT. ADMIN is seeded
--    explicitly: the code-side catalog grants it through the USER_DEFAULT_ATOMS concat, and
--    DefaultSetMigrationParityTest requires every code-side-held atom of a seeded role to have its
--    mirror row here (freshDatabaseMaterializesExactlyTheCodeSideCatalog) — the same "capability
--    shrink" reasoning V157 documented: ADMIN must not end up the one role missing a default the
--    rest of its family carries.
-- ---------------------------------------------------------------------------------------------
INSERT INTO role_permissions (role_id, action_class, resource_pattern) VALUES
    ('00000000-0000-4000-8000-000000000001', 'TEAM_TASK_MANAGE', '*'),  -- SUPER_ADMIN
    ('00000000-0000-4000-8000-000000000002', 'TEAM_TASK_MANAGE', '*'),  -- ADMIN
    ('00000000-0000-4000-8000-000000000003', 'TEAM_TASK_MANAGE', '*'),  -- USER
    ('00000000-0000-4000-8000-000000000008', 'TEAM_TASK_MANAGE', '*'),  -- AGENT_USER
    ('00000000-0000-4000-8000-000000000004', 'TEAM_TASK_MANAGE', '*'),  -- WS_OWNER
    ('00000000-0000-4000-8000-000000000005', 'TEAM_TASK_MANAGE', '*')   -- WS_EDITOR
ON CONFLICT (role_id, action_class, resource_pattern) DO NOTHING;

-- ---------------------------------------------------------------------------------------------
-- 3) Grantees that already exist: same backfill shape as V157:62-88. Scope comes from the
--    BINDING, so an instance-tier SUPER_ADMIN/USER/AGENT_USER grant stays instance-scope and a
--    WS_* binding stays workspace-scope. Both subject kinds participate: WS_* roles are bindable
--    to agent principals (BL-349) and the teammate claim path needs the materialized row.
-- ---------------------------------------------------------------------------------------------
INSERT INTO grants (id, granter_type, granter_id, subject_type, subject_id, permissions, source,
                    scope_type, scope_id, read_state)
SELECT DISTINCT ON (b.subject_type, b.subject_id, b.scope_type, b.scope_id, rp.action_class)
       gen_random_uuid(),
       CASE WHEN b.granted_by IS NULL THEN NULL ELSE 'user' END,
       b.granted_by,
       b.subject_type, b.subject_id,
       jsonb_build_array(jsonb_build_object('actionClass', rp.action_class)),
       'role', b.scope_type, b.scope_id, 'read'
FROM role_bindings b
JOIN role_permissions rp ON rp.role_id = b.role_id
WHERE rp.action_class = 'TEAM_TASK_MANAGE'
  AND b.role_id IN ('00000000-0000-4000-8000-000000000001',  -- SUPER_ADMIN
                    '00000000-0000-4000-8000-000000000002',  -- ADMIN
                    '00000000-0000-4000-8000-000000000003',  -- USER
                    '00000000-0000-4000-8000-000000000008',  -- AGENT_USER
                    '00000000-0000-4000-8000-000000000004',  -- WS_OWNER
                    '00000000-0000-4000-8000-000000000005')  -- WS_EDITOR
  AND NOT EXISTS (
      SELECT 1 FROM grants g
      WHERE g.subject_type = b.subject_type
        AND g.subject_id = b.subject_id
        AND g.source = 'role'
        AND g.scope_type = b.scope_type
        AND g.scope_id IS NOT DISTINCT FROM b.scope_id
        AND g.permissions->0->>'actionClass' = rp.action_class);
