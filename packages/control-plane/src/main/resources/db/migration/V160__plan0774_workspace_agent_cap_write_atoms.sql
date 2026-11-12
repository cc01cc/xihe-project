-- V160 (PLAN-0774 / task-11): extend stored workspace agent cap snapshots with the two write
-- atoms that V157 introduced, for the rows that are actually entitled to them.
--
-- What is broken today: `workspace_agents.permissions_snapshot` froze the cap at bind time.
-- V157 added WRITE_WORKSPACE_CONTENT / MANAGE_WORKSPACE_MCP to role_permissions and materialized
-- role grants for existing bindings, but the frozen cap rows were never revisited, and
-- `resolveCapFor` intersects the snapshot with the effective grants
-- (AgentPrincipalService.java:728-740 => retainCovered(binding, principal)), so an atom that is
-- granted but missing from the snapshot is silently dropped at evaluation time - the agent is
-- refused by the new gates even though its role carries the atom. V160 repairs the snapshot.
--
-- Predicates (frozen in plans/PLAN-0774-XH-agent-cap-snapshot-write-atoms/design.md 4.2):
--   FIRST LEG  (D-1080 (3)): only patch when `grants` ALREADY holds the atom for this subject in
--              this scope - otherwise the migration would invent a capability the evaluator
--              would never retain, and the audit claim 'already held' would be false. Scope and
--              source-branch reproduce AuthorizationGrantRepository.findScopedGrants:39-46 and
--              AgentPrincipalService.principalEffectiveAtoms:922-936 verbatim:
--                scope: g.scope_type='instance' OR (g.scope_type='workspace' AND
--                       g.scope_id = wa.workspace_id)      -- instance rows always participate
--                branch A: if ANY grant row with source IN ('role','credential_binding') exists,
--                          the effective set is those two sources only;
--                branch B: otherwise the six EVALUATION_SOURCES (GrantSources.java:50-51).
--   SECOND LEG (D-1083 / 44B, un-narrowed guard): only patch rows whose snapshot still contains
--              the whole ROLE BASELINE = the subject's source='role' atoms in this workspace,
--              MINUS the two atoms being added (that subtraction is exactly what V157 froze, so
--              Baseline is what the cap should have contained at V156 time).
--                snapshot does NOT contain the baseline => an admin narrowed the cap on purpose
--                  via setWorkspaceCap => DO NOT widen it back, write a skipped audit
--                  (reason='cap_narrowed').
--                baseline empty (no role atoms beyond the two) => nothing to prove it was not
--                  narrowed => DO NOT patch, skipped audit (reason='no_role_baseline').
--              Rationale: permission surfaces must under-grant rather than over-grant - an
--              under-grant is reported immediately by the user, an over-grant is not.
--
-- Shape notes (why this is ONE statement and not the two segments sketched in design 4.1):
--   * the accounting invariant in design 'Data migration and reconciliation' is
--     extended + skipped <= total rows. Two per-atom passes would emit up to 2 audit rows for one
--     row (and 2 identical 'cap_narrowed' rows for a row missing both atoms), which breaks that
--     invariant and makes reconciliation unreadable. One pass computes the row's full missing-atom
--     set, appends it once, and emits exactly one audit row per row.
--   * appended atoms carry only `actionClass`, never `resource` - that is exactly what
--     AgentPrincipalService.toJson:1547-1561 writes for a wildcard atom (it omits `resource` when
--     it is '*'), and mirroring a grant's concrete resource would narrow the cap below the grant.
--   * `||` appends at the tail; the read path parses the array into a Set, so order carries no
--     meaning (the appended block is sorted anyway, for stable diffs).
--
-- Idempotency: the patch branch is guarded by 'snapshot does not yet contain the atom' and the
-- skipped branch de-duplicates on (action, resource_id, workspace_id, source marker), so a manual
-- replay of this file is a 0-row no-op on both branches. Flyway never re-runs a version, which is
-- why the replay is verified by the test lane (M2 T2.1 case 7), not by Flyway itself.
--
-- Number allocation (three checks, 2026-11-13 00:2x, PLAN-0774 M0 T0.1):
--   develop tree     count=151 max=159
--   all refs         173 refs scanned, everMax=159 (everMax unchanged, so no lane holds a higher number)
--   V160 files       none in this checkout, none in any ref
--   => V160, registered in internal/A03-xihe/docs/migration-numbers.md 0/4 as 'reserved, not on disk'.
--   Related: V157__plan0773_workspace_write_atoms.sql is the migration that created the atom
--   catalogue entries (role_permissions + role grants). V160 deliberately does NOT touch the atom
--   catalogue - it only widens existing snapshots.
--
-- Fail-closed precondition (design 'implementation-time checks' Q3): the historical jsonb SHAPE of
-- permissions_snapshot has never been measured (dev database had 0 rows; the shape is only
-- constructible in test fixtures). `jsonb || jsonb` raises when mixing an object with an array, so a
-- non-array row would abort the migration with a generic operator error. This block turns that into
-- one explicit refusal that names the row count, instead of guessing or silently skipping.
DO $$
DECLARE
    non_array_rows BIGINT;
BEGIN
    SELECT count(*) INTO non_array_rows
    FROM workspace_agents
    WHERE jsonb_typeof(permissions_snapshot) <> 'array';
    IF non_array_rows > 0 THEN
        RAISE EXCEPTION
            'V160 refuses to run: % workspace_agents row(s) hold a non-array permissions_snapshot;'
            ' this migration appends atoms and will not guess a shape', non_array_rows;
    END IF;
END $$;

-- One statement: assess -> patch -> audit (extended) -> audit (skipped). The trailing SELECT is
-- the reconciliation read-out (extended / skipped / total) for the window that applies it.
WITH facts AS (
    SELECT w.principal_id,
           w.workspace_id,
           w.permissions_snapshot AS before,
           ARRAY(SELECT DISTINCT a.atom ->> 'actionClass'
                 FROM grants g
                 CROSS JOIN LATERAL jsonb_array_elements(g.permissions) AS a(atom)
                 WHERE g.subject_type = 'agent_principal'
                   AND g.subject_id = w.principal_id
                   AND (g.scope_type = 'instance'
                        OR (g.scope_type = 'workspace' AND g.scope_id = w.workspace_id))
                   AND g.source IN ('role', 'credential_binding')) AS branch_a_atoms,
           ARRAY(SELECT DISTINCT a.atom ->> 'actionClass'
                 FROM grants g
                 CROSS JOIN LATERAL jsonb_array_elements(g.permissions) AS a(atom)
                 WHERE g.subject_type = 'agent_principal'
                   AND g.subject_id = w.principal_id
                   AND (g.scope_type = 'instance'
                        OR (g.scope_type = 'workspace' AND g.scope_id = w.workspace_id))
                   AND g.source IN ('role', 'spawn', 'template', 'credential_binding',
                                    'agent_default', 'plugin_binding')) AS all_sources_atoms,
           ARRAY(SELECT DISTINCT a.atom ->> 'actionClass'
                 FROM grants g
                 CROSS JOIN LATERAL jsonb_array_elements(g.permissions) AS a(atom)
                 WHERE g.subject_type = 'agent_principal'
                   AND g.subject_id = w.principal_id
                   AND (g.scope_type = 'instance'
                        OR (g.scope_type = 'workspace' AND g.scope_id = w.workspace_id))
                   AND g.source = 'role') AS role_atoms
    FROM workspace_agents w
),
effective AS (
    -- principalEffectiveAtoms: branch A wins when it is non-empty, otherwise the six sources.
    SELECT f.principal_id,
           f.workspace_id,
           f.before,
           f.role_atoms,
           CASE WHEN cardinality(f.branch_a_atoms) > 0
                THEN f.branch_a_atoms
                ELSE f.all_sources_atoms
           END AS effective_atoms
    FROM facts f
),
missing AS (
    -- FIRST LEG + the atom-presence test: an atom is a candidate only when the effective set holds
    -- it and the snapshot does not.
    SELECT e.principal_id,
           e.workspace_id,
           e.before,
           e.role_atoms,
           ARRAY(SELECT x.atom
                 FROM unnest(ARRAY['MANAGE_WORKSPACE_MCP', 'WRITE_WORKSPACE_CONTENT']) AS x(atom)
                 WHERE e.effective_atoms @> ARRAY[x.atom]
                   AND NOT (e.before @> jsonb_build_array(jsonb_build_object('actionClass', x.atom)))
                 ORDER BY x.atom) AS missing_atoms
    FROM effective e
),
assessed AS (
    SELECT m.principal_id,
           m.workspace_id,
           m.before,
           m.missing_atoms,
           CASE WHEN cardinality(m.missing_atoms) > 0
                THEN (SELECT jsonb_agg(jsonb_build_object('actionClass', x.atom) ORDER BY x.atom)
                      FROM unnest(m.missing_atoms) AS x(atom))
           END AS append_json,
           ARRAY(SELECT y.atom
                 FROM unnest(m.role_atoms) AS y(atom)
                 WHERE y.atom NOT IN ('MANAGE_WORKSPACE_MCP', 'WRITE_WORKSPACE_CONTENT')) AS baseline
    FROM missing m
    WHERE cardinality(m.missing_atoms) > 0
),
classified AS (
    -- SECOND LEG (44B): patch only when the snapshot still contains the whole role baseline.
    SELECT a.*,
           (cardinality(a.baseline) > 0
            AND NOT EXISTS (
                SELECT 1
                FROM unnest(a.baseline) AS b(atom)
                WHERE NOT (a.before @> jsonb_build_array(jsonb_build_object('actionClass', b.atom)))
            )) AS patchable
    FROM assessed a
),
patch AS (
    UPDATE workspace_agents w
    SET permissions_snapshot = w.permissions_snapshot || c.append_json
    FROM classified c
    WHERE c.patchable
      AND w.principal_id = c.principal_id
      AND w.workspace_id = c.workspace_id
      -- Optimistic guard: `c.before` was read in this statement's snapshot, while UPDATE
      -- re-evaluates its target against the newest row version. If an admin narrowed the cap in
      -- between, the comparison fails and the row is left untouched - widening a cap somebody
      -- just narrowed is the one outcome this migration must never produce. The next run then
      -- classifies the row as 'cap_narrowed' and audits it, so the end state still converges.
      AND w.permissions_snapshot = c.before
    RETURNING w.principal_id,
              w.workspace_id,
              c.before,
              c.append_json,
              w.permissions_snapshot AS after
),
extended_audit AS (
    INSERT INTO audit_logs (id, user_id, workspace_id, action, resource_type, resource_id, details,
                            created_at)
    SELECT gen_random_uuid(),
           NULL,                              -- system action: no human actor (design 4.3)
           p.workspace_id,
           'agent_workspace_cap_extended',
           'workspace_agent',
           p.principal_id::text,              -- varchar(36) fits a canonical UUID string (V1:378)
           jsonb_build_object(
               'source', 'migration:V160',
               'actor', 'system',
               'at', to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
               'before', p.before,
               'after', p.after,
               'atoms', p.append_json,
               'basis', 'un-narrowed cap + grant already contains atom'
           )::text,
           NOW()
    FROM patch p
    RETURNING id
),
skipped_audit AS (
    INSERT INTO audit_logs (id, user_id, workspace_id, action, resource_type, resource_id, details,
                            created_at)
    SELECT gen_random_uuid(),
           NULL,
           c.workspace_id,
           'agent_workspace_cap_extend_skipped',
           'workspace_agent',
           c.principal_id::text,
           jsonb_build_object(
               'source', 'migration:V160',
               'actor', 'system',
               'at', to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
               'before', c.before,
               'reason', CASE WHEN cardinality(c.baseline) = 0
                              THEN 'no_role_baseline'
                              ELSE 'cap_narrowed'
                         END,
               'missingAtoms', to_jsonb(c.missing_atoms),
               'atoms', to_jsonb(c.missing_atoms),
               'baseline', to_jsonb(c.baseline)
           )::text,
           NOW()
    FROM classified c
    WHERE NOT c.patchable
      -- replay guard: never write the same skip twice (see the idempotency note in the header)
      AND NOT EXISTS (
          SELECT 1
          FROM audit_logs existing
          WHERE existing.action = 'agent_workspace_cap_extend_skipped'
            AND existing.resource_type = 'workspace_agent'
            AND existing.resource_id = c.principal_id::text
            AND existing.workspace_id = c.workspace_id
            AND existing.details LIKE '%migration:V160%'
      )
    RETURNING id
)
SELECT (SELECT count(*) FROM patch)           AS patched_rows,
       (SELECT count(*) FROM extended_audit)  AS extended_audit_rows,
       (SELECT count(*) FROM skipped_audit)   AS skipped_audit_rows,
       (SELECT count(*) FROM workspace_agents) AS total_workspace_agent_rows;
