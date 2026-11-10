-- PLAN-0750 M1 (G1 = (1a), user ruling 2026-11-10): re-plant the CREATE_OWN_AGENT atom.
--
-- Why it comes back: BL-312 (option B, 2026-11-09) deleted PLAN-0622 D8's atom because its shape
-- let an ordinary account bypass the workspace gate. PLAN-0750 keeps the gate and changes the
-- semantics instead: CREATE_OWN_AGENT now authorizes creating one's own **user-level** principal
-- (owner = the actor, no Workspace binding is produced), and the workspace tier (MANAGE_WORKSPACE_AGENTS)
-- and instance tier (CREATE_ACCOUNT) stay untouched and independent — never alias-merged (design #3).
--
-- Default grant set (mirrored in SystemAccessRoleCatalog#roleSeeds — the two must change together or
-- DefaultSetMigrationParityTest / AgentPrincipalScopeMigrationTest#headSeedsMatchTheCodeSideCatalog go red):
--   * SUPER_ADMIN (…0001): holds every catalog atom by parity mandate, not by policy choice.
--   * ADMIN      (…0002): the fixed instance-administrator set derives from USER_DEFAULT_ATOMS.
--   * USER       (…0003): registration default set (an ordinary account may create its own principal).
--   * AGENT_USER (…0008) stays OUT on purpose: an agent principal is a grantee, never an account
--     creator, and the atom is agent-principal-forbidden (PermissionAtomCatalog#AGENT_FORBIDDEN_ATOMS).
--   * WS_* roles stay OUT: the atom is instance-bindable only; a workspace binding of it would be
--     meaningless because the create produces no binding at all.
--
-- No `grants` backfill (same shape as V137, contrast V91): evaluation reads materialized rows, so an
-- existing account keeps its pre-V148 atom set until its next materialization (registration, role
-- edit, owner hand-over). D-215 (user ruling 2026-11-06) says development data carries no migration
-- obligation, and a re-introduced INSERT … SELECT would rebuild the BL-366 duplicate-key trap.
--
-- Number allocation: assigned at merge time as develop's max + 1 (design decision #5 — no
-- pre-reservation). Written as V148 when develop's maximum was V147; the three checks (main
-- checkout / other worktrees' unmerged branches / \`flyway_schema_history\`) are re-run before merge.
--
-- Reversible: DELETE FROM role_permissions WHERE action_class = 'CREATE_OWN_AGENT' (the inverse of
-- this statement, which is what V147 did).

INSERT INTO role_permissions (role_id, action_class, resource_pattern) VALUES
    -- SUPER_ADMIN holds every catalog atom (parity mandate: AgentPrincipalScopeMigrationTest).
    ('00000000-0000-4000-8000-000000000001', 'CREATE_OWN_AGENT', '*'),
    -- ADMIN: the fixed instance-administrator set (derived from USER_DEFAULT_ATOMS in code).
    ('00000000-0000-4000-8000-000000000002', 'CREATE_OWN_AGENT', '*'),
    -- USER: the registration default set — the one role that makes this a user capability.
    ('00000000-0000-4000-8000-000000000003', 'CREATE_OWN_AGENT', '*')
ON CONFLICT (role_id, action_class, resource_pattern) DO NOTHING;

-- Fail closed instead of leaving a half-restored vocabulary: if the three instance roles do not end
-- up holding the atom, the code-side catalog (which now lists it) and the data plane would disagree
-- and every later materialization would silently drop the capability.
DO $$
DECLARE
    planted INTEGER;
BEGIN
    SELECT count(*) INTO planted
    FROM role_permissions
    WHERE action_class = 'CREATE_OWN_AGENT'
      AND role_id IN ('00000000-0000-4000-8000-000000000001',
                      '00000000-0000-4000-8000-000000000002',
                      '00000000-0000-4000-8000-000000000003');
    IF planted <> 3 THEN
        RAISE EXCEPTION 'V148 aborted: expected 3 CREATE_OWN_AGENT seed rows, found %', planted;
    END IF;
    -- AGENT_USER must never carry it (agent-principal-forbidden).
    IF EXISTS (SELECT 1 FROM role_permissions
               WHERE action_class = 'CREATE_OWN_AGENT'
                 AND role_id = '00000000-0000-4000-8000-000000000008') THEN
        RAISE EXCEPTION 'V148 aborted: AGENT_USER must not carry the agent-forbidden CREATE_OWN_AGENT';
    END IF;
END $$;
