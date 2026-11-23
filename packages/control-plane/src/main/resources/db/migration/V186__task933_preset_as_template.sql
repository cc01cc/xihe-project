-- task-933 / R39 (D-1926): the grant preset becomes a READ-ONLY TEMPLATE.
--
-- Semantics: a materialized atom is no longer "the union of the subject's bindings"
-- ({@code source='preset'}); it is ONE IMPORT of a template, after which every subject may
-- fine-tune independently ({@code source='assigned'} + {@code origin_preset_id}). Editing a
-- preset therefore never rewrites its holders' rows again (the automatic per-edit reconcile was
-- exactly the binding R39 forbids; {@code PresetGrantMaterializer} now re-materializes only on a
-- binding change, plus an explicit governance replay of {@code materializePreset}).
--
-- Same-batch contract (the split-half silent-DENY trap): GrantSources.EVALUATION_SOURCES and
-- WRITABLE_SOURCES drop {@code preset} and gain {@code assigned} in the SAME commit as this
-- file. Editing only one side either keeps evaluating historical rows (the constants still list
-- {@code preset}) or silently zeroes every materialized subject (constants closed while the rows
-- still say {@code preset}). PluginBindingGrantSourceMigrationTest and SpecFieldConformanceTest
-- compare the CHECK against the Java lists element-wise, so a one-sided edit fails on a real
-- PostgreSQL.
--
-- Data handling, both faces in one file (the user ruling: "no migration needed" covers the new
-- install face only -- "usable from an empty database"; an EXISTING database still gets a
-- verifiable conversion instead of a refused boot):
--   1) {@code origin_preset_id} column: display/compare/realign provenance ONLY, never a
--      filter. Deliberately no CHECK on it: an orphaned id (a deleted custom preset) must not
--      break the read face -- {@code PresetGrantAdminService.delete} still refuses while a
--      preset is bound, so an id only survives a direct-SQL deletion, exactly the
--      "history may not resolve" case the column must tolerate.
--   2) Conversion {@code preset -> assigned}: one UPDATE between the DROP and the ADD of the
--      CHECK, so no half-state can persist (shape copied from V182).
--   3) Backfill rule, stated exactly: a converted row's atom is
--      {@code (subject, scope, actionClass[, resource])}; when {@code grant_preset_bindings ->
--      grant_preset_atoms} matches atoms from EXACTLY ONE DISTINCT preset for it, backfill that
--      preset's id; ANY OTHER cardinality (0 or >= 2) backfills NULL. Counted over DISTINCT
--      role_id, not over rows: one preset carrying the atom in two shapes would otherwise pass a
--      per-role HAVING while two matching presets each pass it too, and a scalar subquery must not
--      return more than one row (21000). The id is the PRESET id, not the binding row id, because
--      {@code uq_role_bindings} (V87) allows one binding per (role, subject, scope) — so the preset
--      id is already a unique import-group key per scope, it survives an unbind/rebind (a binding
--      row id would not: the recreated binding would leave the old row unattributable forever,
--      which is a privilege leak rather than a revoke), and it names the template the column is
--      meant to cite. NULL is not a guess:
--      {@code PresetGrantMaterializer} pins NULL-origin rows to the unattributed group, which
--      no group rewrite may delete (a manual grant is local work) -- the safe reading of
--      "cannot tell which preset it came from". Multi-binding rows are deliberately NOT
--      guessed: compare/realign on them reads "no template" rather than a wrong one.
--   4) {@code uq_grants_role_atom} (V87): its partial predicate read {@code source='role'},
--      V182 renamed the value to {@code 'preset'} and NEVER rebuilt the index -- so the key has
--      been DEAD since V182 (a (subject, scope, atom) duplicate never existed in the old code
--      either). Rebuilt here on {@code source='assigned'} INCLUDING {@code origin_preset_id}:
--      two presets imported into one scope must stay two rows (per-group reconcile), so the
--      import id joins the key; the NULL-origin arm degenerates to the old (scope, atom) key.
--
-- Consumer contract: GrantSources.ASSIGNED / PROVENANCE_SOURCES mirror these values in code;
-- {@code PRESET} stays in the provenance vocabulary only (the task-124 SESSION_TEMP precedent):
-- "no longer participates in a decision, historical rows stay readable".

ALTER TABLE grants ADD COLUMN origin_preset_id uuid;

COMMENT ON COLUMN grants.origin_preset_id IS
    'task-933/R39: the read-only template this imported atom came from (assigned rows only); display/compare/realign provenance, NEVER an evaluation filter; NULL = unattributed local work (a manual grant, or a legacy row whose backfill matched 0 or >= 2 presets)';

-- (1) Order matters and is copied from V182 verbatim: DROP the old CHECK FIRST, because V182's
--     constraint admits only ('preset','spawn','template','credential_binding','agent_default',
--     'plugin_binding') — writing 'assigned' under it fails with 23514 and the whole upgrade aborts
--     (measured on a real PostgreSQL 17 migrating V181 → head). The conversion + backfill therefore
--     run in the constraint-free window, and the narrowed CHECK is re-added only once nothing says
--     'preset' anymore. The same batch rebuilds the unique key afterwards.
ALTER TABLE grants DROP CONSTRAINT ck_grants_source;

UPDATE grants g
SET origin_preset_id = (
        -- PostgreSQL has no min(uuid) aggregate, hence the text round-trip.
        SELECT CASE WHEN count(DISTINCT b.role_id) = 1
                    THEN min(b.role_id::text)::uuid END
        FROM grant_preset_bindings b
        JOIN grant_preset_atoms a ON a.role_id = b.role_id
        WHERE b.subject_type = g.subject_type
          AND b.subject_id = g.subject_id
          AND b.scope_type = g.scope_type
          AND b.scope_id IS NOT DISTINCT FROM g.scope_id
          AND a.action_class = g.permissions #>> '{0,actionClass}'
          AND COALESCE(g.permissions #>> '{0,resource}', '*')
              = COALESCE(a.resource_pattern, '*')
    ),
    source = 'assigned'
WHERE g.source = 'preset';

ALTER TABLE grants ADD CONSTRAINT ck_grants_source
    CHECK (source IN ('assigned', 'spawn', 'template', 'credential_binding', 'agent_default',
                      'plugin_binding'));

DROP INDEX IF EXISTS uq_grants_role_atom;
CREATE UNIQUE INDEX uq_grants_role_atom
    ON grants (subject_type, subject_id, scope_type, scope_id, origin_preset_id,
               (permissions -> 0 ->> 'actionClass'),
               (COALESCE(permissions -> 0 ->> 'resource', '*')))
    NULLS NOT DISTINCT
    WHERE source = 'assigned';
