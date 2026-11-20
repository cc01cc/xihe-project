-- V179 (task-116 / DSD-1500, Q-93 R2 + R3): exec leaves the agent default stack, and three agent
-- presets land so "work without executing" is expressible without hand-assembled temp grants.
--
-- Number allocation (2026-11-20, implementation time): develop tree max = V178 (task-108 / D-1908
-- rev3, merged by task-115); V177 was reserved for task-106's workspace_agents.is_default and is not
-- in this tree. => V179, not a guess.
--
-- Why R2 exists (the ruling's own words, DSD-1500): a freshly created agent principal is bound to
-- AGENT_USER (instance, AgentPrincipalService:71) + WS_EDITOR (workspace, :69), and AGENT_USER's seed
-- was BASE_ATOMS, which carries exec. On the default runtime backend (windows-host,
-- packages/runtime/src/job_host_adapter.rs:1-5 "no sandbox, no policy") exec == unconstrained command
-- execution on the host, by default. GrantIntersectionEvaluator.allows intersects EVERY level of the
-- principal path, so removing exec from only one of the two roles would have changed nothing.
--
-- Why R3 exists: the current 8 system roles left only WS_VIEWER (read + runtime) and WS_EDITOR
-- (read/write/delete/…/exec) as agent-bindable middle ground, so "read/write but never execute" could
-- only be assembled per session. AGENT_READER / AGENT_WORKER / WS_RUNNER are ordinary built-in roles
-- (fixed ids in the V87 id space, is_system = TRUE); the scope of a role lives on the binding, so the
-- same role may be bound at instance scope (reach) and at workspace scope (cap reach). exec needs
-- BOTH after R2 — that is the intended, explicit, per-principal act.
--
-- Stale-grant cleanup (V130 precedent): role_permissions is configuration, but the materialized
-- source='role' grant rows V87/V107/V127 wrote are derived state. A row that carries exec while no
-- remaining role declaration covers (subject, scope) would keep the atom alive on agent subjects that
-- the catalog says no longer hold it. Human instance roles (USER/ADMIN/SUPER_ADMIN) still declare exec,
-- so their rows are kept by the NOT EXISTS predicate; only subjects whose every declaring role lost
-- exec are narrowed. Idempotent (re-running deletes zero rows); reversible by re-inserting the two
-- role_permissions rows and re-materializing the affected bindings.

-- ---------------------------------------------------------------------------------------------
-- 1) R2: exec leaves AGENT_USER (instance default) and WS_EDITOR (workspace default).
-- ---------------------------------------------------------------------------------------------
DELETE FROM role_permissions
WHERE role_id IN (
        '00000000-0000-4000-8000-000000000008', -- AGENT_USER
        '00000000-0000-4000-8000-000000000005'  -- WS_EDITOR
    )
  AND action_class = 'exec';

-- Derived state from the pre-R2 catalog: drop exec grants whose subject/scope has no declaring role
-- left. (Multi-atom grant rows do not exist for source='role' — the materializer writes one row per
-- action class, V178:56-70 shape.)
DELETE FROM grants g
WHERE g.source = 'role'
  AND g.permissions @> '[{"actionClass": "exec"}]'::jsonb
  AND NOT EXISTS (
      SELECT 1
      FROM role_bindings b
      JOIN role_permissions rp ON rp.role_id = b.role_id
      WHERE b.subject_type = g.subject_type
        AND b.subject_id = g.subject_id
        AND b.scope_type = g.scope_type
        AND b.scope_id IS NOT DISTINCT FROM g.scope_id
        AND rp.action_class = 'exec');

-- ---------------------------------------------------------------------------------------------
-- 2) R3: the three presets (form copied from V109:28-33 / V127:21-25).
-- ---------------------------------------------------------------------------------------------
INSERT INTO roles (id, name, display_name, description, is_system) VALUES
    ('00000000-0000-4000-8000-000000000009', 'AGENT_READER', 'Agent Reader',
     'DSD-1500 R3: read-only agent preset — read + workspace runtime, nothing that writes.', TRUE),
    ('00000000-0000-4000-8000-000000000010', 'AGENT_WORKER', 'Agent Worker',
     'DSD-1500 R3: read/write/delete agent preset with no exec — the non-executing worker tier.', TRUE),
    ('00000000-0000-4000-8000-000000000011', 'WS_RUNNER', 'Workspace Runner',
     'DSD-1500 R2/R3: exec + workspace runtime — the explicit execution preset; never granted by default.', TRUE)
ON CONFLICT (id) DO NOTHING;

INSERT INTO role_permissions (role_id, action_class, resource_pattern) VALUES
    -- AGENT_READER: WS_VIEWER's atom set, for agent principals.
    ('00000000-0000-4000-8000-000000000009', 'read', '*'),
    ('00000000-0000-4000-8000-000000000009', 'USE_WORKSPACE_RUNTIME', '*'),
    -- AGENT_WORKER: read/write/delete only. No network, no plugin invoke, no exec: a preset that
    -- decides to widen a particular principal can add those explicitly, never by accident.
    ('00000000-0000-4000-8000-000000000010', 'read', '*'),
    ('00000000-0000-4000-8000-000000000010', 'write', '*'),
    ('00000000-0000-4000-8000-000000000010', 'delete', '*'),
    -- WS_RUNNER: exec + the runtime channel, nothing administrative.
    ('00000000-0000-4000-8000-000000000011', 'exec', '*'),
    ('00000000-0000-4000-8000-000000000011', 'USE_WORKSPACE_RUNTIME', '*')
ON CONFLICT (role_id, action_class, resource_pattern) DO NOTHING;

-- No grant backfill on purpose: unlike V157/V172/V178 these roles are NOT defaults for anybody, so
-- there are no existing bindings whose materialization would go stale. The first explicit binding is
-- what materializes them (RoleGrantMaterializer), and DefaultSetMigrationParityTest's SUPER_ADMIN
-- column needs no row here: none of these role_permissions introduces a new atom, so superAdminAtoms()
-- is unchanged.
