-- PLAN-0610 T1.1/T1.2: dynamic access roles (roles / role_permissions / role_bindings),
-- scoped materialization columns on grants, and the built-in role catalog.
--
-- Round-2 correction (P0): the source allow-list is *widened* here, not narrowed. Existing
-- databases still carry `default` (V41 backfill) and `direct` (PLAN-0496 credential bindings)
-- rows; the `default -> role` / `direct -> credential_binding` / agent-default conversion runs
-- in V88. V87 therefore keeps every legacy value valid and only adds the new ones:
--   * `role`              - materialized union of the subject's role bindings (this plan)
--   * `agent_default`     - frozen snapshot written by ensureAgentSessionDefault (P1-1)
--   * `credential_binding`- PLAN-0496 credential binding writer (M0 D3)
-- The legacy partial unique indexes (uq_grants_default_subject from V38, uq_grants_direct_subject
-- from V65) stay in place until V88 converts their rows; their semantic successors are created
-- below with the scope columns added to the key.
--
-- * Reversible: DROP the three tables, DROP the grants.scope_* columns and restore the V38
--   ck_grants_source definition (the added indexes drop with their columns/tables).

CREATE TABLE roles (
    id           UUID PRIMARY KEY,
    name         VARCHAR(64) NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    description  TEXT,
    is_system    BOOLEAN NOT NULL DEFAULT FALSE,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT ck_roles_name_format CHECK (name ~ '^[A-Z][A-Z0-9_]{1,63}$')
);

-- `role_permissions` stores the atom *name* only. The scope class of an atom (`instance` /
-- `workspace` / `both`) and the capability/action split live in code
-- (`PermissionAtomCatalog`), which is the SSOT for `scope_class` (round-2 P1: the
-- `/roles/catalog` view derives scope_class from code, never from a stored copy).
CREATE TABLE role_permissions (
    role_id          UUID NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    action_class     VARCHAR(64) NOT NULL,
    resource_pattern VARCHAR(255) NOT NULL DEFAULT '*',
    CONSTRAINT pk_role_permissions PRIMARY KEY (role_id, action_class, resource_pattern)
);

CREATE TABLE role_bindings (
    id           UUID PRIMARY KEY,
    role_id      UUID NOT NULL REFERENCES roles(id) ON DELETE RESTRICT,
    subject_type VARCHAR(24) NOT NULL,
    subject_id   UUID NOT NULL,
    scope_type   VARCHAR(16) NOT NULL,
    scope_id     UUID REFERENCES workspaces(id) ON DELETE CASCADE,
    granted_by   UUID REFERENCES users(id) ON DELETE SET NULL,
    granted_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT ck_role_bindings_subject_type CHECK (subject_type IN ('user', 'agent_principal')),
    CONSTRAINT ck_role_bindings_scope_type CHECK (scope_type IN ('instance', 'workspace')),
    CONSTRAINT ck_role_bindings_scope CHECK ((scope_type = 'instance' AND scope_id IS NULL)
                                          OR (scope_type = 'workspace' AND scope_id IS NOT NULL)),
    -- PostgreSQL default is NULLS DISTINCT, which would let two instance-scope bindings of the
    -- same (role, subject) coexist (scope_id is NULL for both). The whole point of the key is
    -- "one binding per role x subject x scope", so the NULL slots must collide.
    CONSTRAINT uq_role_bindings UNIQUE NULLS NOT DISTINCT
        (role_id, subject_type, subject_id, scope_type, scope_id)
);

CREATE INDEX idx_role_bindings_subject ON role_bindings (subject_type, subject_id);
CREATE INDEX idx_role_bindings_role ON role_bindings (role_id);

-- ---------------------------------------------------------------------------
-- grants: scoped materialization (round-1 P0-1 / round-2 P1-2)
-- ---------------------------------------------------------------------------

ALTER TABLE grants ADD COLUMN scope_type VARCHAR(16) NOT NULL DEFAULT 'instance';
ALTER TABLE grants ADD COLUMN scope_id UUID;

ALTER TABLE grants ADD CONSTRAINT ck_grants_scope
    CHECK ((scope_type = 'instance' AND scope_id IS NULL)
        OR (scope_type = 'workspace' AND scope_id IS NOT NULL));

-- Deleting a workspace must not leave workspace-scoped materialized rows (or bindings) behind.
ALTER TABLE grants ADD CONSTRAINT fk_grants_scope_workspace
    FOREIGN KEY (scope_id) REFERENCES workspaces(id) ON DELETE CASCADE;

-- Widened allow-list: see the header comment. V88 narrows this to
-- ('role', 'spawn', 'template', 'credential_binding', 'agent_default').
-- `source` is VARCHAR(16) since V38 and the longest new value is 'credential_binding' (18),
-- so the column must grow in the same migration.
ALTER TABLE grants ALTER COLUMN source TYPE VARCHAR(24);
ALTER TABLE grants DROP CONSTRAINT ck_grants_source;
ALTER TABLE grants ADD CONSTRAINT ck_grants_source
    CHECK (source IN ('default', 'direct', 'role', 'spawn', 'template',
                      'credential_binding', 'agent_default'));

CREATE INDEX idx_grants_subject_scope
    ON grants (subject_type, subject_id, scope_type, scope_id);

-- One materialized row per atom (round-2 P1-2: the uniqueness key carries actionClass +
-- resource). The role materializer writes single-atom rows, so the jsonb path expressions are
-- exact; a multi-atom row cannot silently satisfy a narrower key.
CREATE UNIQUE INDEX uq_grants_role_atom
    ON grants (subject_type, subject_id, scope_type, scope_id,
               (permissions -> 0 ->> 'actionClass'),
               (COALESCE(permissions -> 0 ->> 'resource', '*')))
    NULLS NOT DISTINCT
    WHERE source = 'role';

-- V65 semantics preserved under the new name: one credential-binding row per subject. Losing
-- this fence reintroduces the two-concurrent-binds bug recorded in V65 (unbind clears one row,
-- the other keeps the atom while the audit already says removed).
CREATE UNIQUE INDEX uq_grants_credential_binding_subject
    ON grants (subject_type, subject_id)
    WHERE source = 'credential_binding';

-- Successor of V38's uq_grants_default_subject for the frozen agent snapshot (P1-1).
CREATE UNIQUE INDEX uq_grants_agent_default_subject
    ON grants (subject_type, subject_id)
    WHERE source = 'agent_default';

-- ---------------------------------------------------------------------------
-- Built-in role catalog (T1.2, round-2 P1-3)
--   instance scope : SUPER_ADMIN (15 action atoms + 3 capability atoms = 18), ADMIN, USER
--   workspace scope: WS_OWNER, WS_EDITOR, WS_VIEWER  (aligned with the OpenAPI `WorkspaceRole`
--                    enum; the legacy ADMIN/MEMBER spellings canonicalize to EDITOR in V88)
-- Ids are fixed so the code-side catalog (`SystemAccessRoleCatalog`) can bootstrap a schema
-- built from entities (the H2 test profile) and a migration test can prove both sides agree.
-- ---------------------------------------------------------------------------

INSERT INTO roles (id, name, display_name, description, is_system) VALUES
    ('00000000-0000-4000-8000-000000000001', 'SUPER_ADMIN', 'Super Administrator',
     'Instance scope: every action atom plus every capability atom. Immutable.', TRUE),
    ('00000000-0000-4000-8000-000000000002', 'ADMIN', 'Administrator',
     'Instance scope: the default action set plus the three credential atoms and instance:admin.', TRUE),
    ('00000000-0000-4000-8000-000000000003', 'USER', 'User',
     'Instance scope: the registration minimal set (read/write/delete/exec/network).', TRUE),
    ('00000000-0000-4000-8000-000000000004', 'WS_OWNER', 'Workspace Owner',
     'Workspace scope: editor actions plus workspace agent management and workspace:admin.', TRUE),
    ('00000000-0000-4000-8000-000000000005', 'WS_EDITOR', 'Workspace Editor',
     'Workspace scope: read/write/delete/exec.', TRUE),
    ('00000000-0000-4000-8000-000000000006', 'WS_VIEWER', 'Workspace Viewer',
     'Workspace scope: read only.', TRUE);

-- SUPER_ADMIN: 15 action atoms.
INSERT INTO role_permissions (role_id, action_class, resource_pattern) VALUES
    ('00000000-0000-4000-8000-000000000001', 'read', '*'),
    ('00000000-0000-4000-8000-000000000001', 'write', '*'),
    ('00000000-0000-4000-8000-000000000001', 'delete', '*'),
    ('00000000-0000-4000-8000-000000000001', 'exec', '*'),
    ('00000000-0000-4000-8000-000000000001', 'network', '*'),
    ('00000000-0000-4000-8000-000000000001', 'credential_use', 'credential:*'),
    ('00000000-0000-4000-8000-000000000001', 'credential_reveal', 'credential:*'),
    ('00000000-0000-4000-8000-000000000001', 'credential_manage', 'credential:*'),
    ('00000000-0000-4000-8000-000000000001', 'CREATE_ACCOUNT', '*'),
    ('00000000-0000-4000-8000-000000000001', 'CREATE_TEMPLATE', '*'),
    ('00000000-0000-4000-8000-000000000001', 'MANAGE_WORKSPACE_AGENTS', '*'),
    ('00000000-0000-4000-8000-000000000001', 'SPAWN_AGENT', '*'),
    ('00000000-0000-4000-8000-000000000001', 'CREATE_SCHEDULED_TASK', '*'),
    ('00000000-0000-4000-8000-000000000001', 'MANAGE_SCHEDULED_TASK', '*'),
    ('00000000-0000-4000-8000-000000000001', 'MANAGE_ROLES', '*'),
    -- 3 capability atoms; never materialized into grants.
    ('00000000-0000-4000-8000-000000000001', 'instance:super', '*'),
    ('00000000-0000-4000-8000-000000000001', 'instance:admin', '*'),
    ('00000000-0000-4000-8000-000000000001', 'workspace:admin', '*');

-- ADMIN: USER set + three credential atoms + instance:admin.
INSERT INTO role_permissions (role_id, action_class, resource_pattern) VALUES
    ('00000000-0000-4000-8000-000000000002', 'read', '*'),
    ('00000000-0000-4000-8000-000000000002', 'write', '*'),
    ('00000000-0000-4000-8000-000000000002', 'delete', '*'),
    ('00000000-0000-4000-8000-000000000002', 'exec', '*'),
    ('00000000-0000-4000-8000-000000000002', 'network', '*'),
    ('00000000-0000-4000-8000-000000000002', 'credential_use', 'credential:*'),
    ('00000000-0000-4000-8000-000000000002', 'credential_reveal', 'credential:*'),
    ('00000000-0000-4000-8000-000000000002', 'credential_manage', 'credential:*'),
    ('00000000-0000-4000-8000-000000000002', 'instance:admin', '*');

-- USER: registration minimal set.
INSERT INTO role_permissions (role_id, action_class, resource_pattern) VALUES
    ('00000000-0000-4000-8000-000000000003', 'read', '*'),
    ('00000000-0000-4000-8000-000000000003', 'write', '*'),
    ('00000000-0000-4000-8000-000000000003', 'delete', '*'),
    ('00000000-0000-4000-8000-000000000003', 'exec', '*'),
    ('00000000-0000-4000-8000-000000000003', 'network', '*');

-- WS_OWNER: WS_EDITOR + MANAGE_WORKSPACE_AGENTS + workspace:admin.
INSERT INTO role_permissions (role_id, action_class, resource_pattern) VALUES
    ('00000000-0000-4000-8000-000000000004', 'read', '*'),
    ('00000000-0000-4000-8000-000000000004', 'write', '*'),
    ('00000000-0000-4000-8000-000000000004', 'delete', '*'),
    ('00000000-0000-4000-8000-000000000004', 'exec', '*'),
    ('00000000-0000-4000-8000-000000000004', 'MANAGE_WORKSPACE_AGENTS', '*'),
    ('00000000-0000-4000-8000-000000000004', 'workspace:admin', '*');

-- WS_EDITOR.
INSERT INTO role_permissions (role_id, action_class, resource_pattern) VALUES
    ('00000000-0000-4000-8000-000000000005', 'read', '*'),
    ('00000000-0000-4000-8000-000000000005', 'write', '*'),
    ('00000000-0000-4000-8000-000000000005', 'delete', '*'),
    ('00000000-0000-4000-8000-000000000005', 'exec', '*');

-- WS_VIEWER.
INSERT INTO role_permissions (role_id, action_class, resource_pattern) VALUES
    ('00000000-0000-4000-8000-000000000006', 'read', '*');
