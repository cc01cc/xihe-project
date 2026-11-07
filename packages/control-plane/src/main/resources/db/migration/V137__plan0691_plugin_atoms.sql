-- PLAN-0691 T1.3 (M1): the plugin binding permission atoms and their default grant sets.
--
-- One catalog, one naming convention. The spec (spec/authz-plugin-atoms.md) words the capability
-- face as `plugin:manage` / `plugin:bind` / `plugin:invoke` / `plugin:data`; the atoms that reach the
-- catalog are UPPER_SNAKE, like all 29 existing action atoms. Reason: DefaultSetMatrixTest and
-- DefaultSetMigrationParityTest assert "SUPER_ADMIN holds every atom in the catalog", so a catalog
-- carrying two naming conventions would fork every prefix- or case-based parse and audit afterwards.
--
-- Default grant sets (spec B-4, mirrored in SystemAccessRoleCatalog#roleSeeds — the two must change
-- together or DefaultSetMigrationParityTest goes red):
--   * PLUGIN_MANAGE (instance scope, agent-forbidden) → SUPER_ADMIN + ADMIN (fixed
--     instance-administrator set, D51-27).
--   * PLUGIN_BIND (workspace scope, agent-forbidden) → SUPER_ADMIN + ADMIN only. It is NOT seeded
--     onto WS_OWNER even though the spec calls the default "workspace admin": WS_* roles are
--     bindable to agent principals (BL-349) and PermissionAtomCatalog#canBindToAgentPrincipal
--     refuses a role carrying an agent-forbidden atom, so seeding PLUGIN_BIND on WS_OWNER would
--     regress every "bind agent to workspace with a default role" call — exactly the BL-349 failure
--     shape that V130 had to undo. Workspace-tier binding authority in M1 therefore comes from the
--     instance-admin tier; splitting the atom per subject type would be a design change, not a seed.
--   * PLUGIN_INVOKE (workspace scope, NOT agent-forbidden) → the base set every non-viewer role
--     carries: USER, ADMIN, WS_OWNER, WS_EDITOR, AGENT_USER. "builtin ⇒ default set" and
--     "third-party ⇒ explicit grant only" both live in the atom layer, so the seed is the same row
--     for both sources; what differs is evaluation (PluginBindingAuthorization#defaultAtoms).
--   * PLUGIN_DATA (binding/service scope, agent-forbidden) → SUPER_ADMIN only. No human default: the
--     data plane belongs to one binding and is reached by the service principal, never by a person.
--   * WS_VIEWER stays out on purpose: invocation executes a tool face and a read-only role must not.
--
-- INSERT only: zero DDL, zero DROP, no UPDATE of existing rows. Idempotent — uq(role_id,
-- action_class, resource_pattern) on role_permissions makes a re-run insert zero rows.
--
-- No `grants` backfill (contrast V129 part 2): existing bindings keep the atoms they were
-- materialized with until they are re-bound. Per D-215 (2026-11-06) development data carries no
-- migration obligation — a lane/stack may clear and rebuild instead — and re-introducing V129's
-- INSERT … SELECT would also re-introduce the BL-366 duplicate-key trap on upgrade paths.
--
-- Number allocation (checks at implementation time, 2026-11-06): main checkout history max = V136;
-- this worktree max = V136; `V137` absent from develop history and every worktree ⇒ V137 is free.
--
-- Reversible: delete the eleven role_permissions rows below (audit_logs is not rewritten).

INSERT INTO role_permissions (role_id, action_class, resource_pattern) VALUES
    -- SUPER_ADMIN holds every catalog atom (parity mandate, not a policy choice).
    ('00000000-0000-4000-8000-000000000001', 'PLUGIN_MANAGE', '*'),
    ('00000000-0000-4000-8000-000000000001', 'PLUGIN_BIND', '*'),
    ('00000000-0000-4000-8000-000000000001', 'PLUGIN_INVOKE', '*'),
    ('00000000-0000-4000-8000-000000000001', 'PLUGIN_DATA', '*'),
    -- ADMIN: the instance-administrator fixed set.
    ('00000000-0000-4000-8000-000000000002', 'PLUGIN_MANAGE', '*'),
    ('00000000-0000-4000-8000-000000000002', 'PLUGIN_BIND', '*'),
    ('00000000-0000-4000-8000-000000000002', 'PLUGIN_INVOKE', '*'),
    -- PLUGIN_INVOKE: the base set every non-viewer role carries.
    ('00000000-0000-4000-8000-000000000003', 'PLUGIN_INVOKE', '*'),
    ('00000000-0000-4000-8000-000000000004', 'PLUGIN_INVOKE', '*'),
    ('00000000-0000-4000-8000-000000000005', 'PLUGIN_INVOKE', '*'),
    ('00000000-0000-4000-8000-000000000008', 'PLUGIN_INVOKE', '*')
ON CONFLICT (role_id, action_class, resource_pattern) DO NOTHING;
