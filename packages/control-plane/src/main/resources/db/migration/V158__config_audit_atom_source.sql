-- task-309 (user ruling b, 2026-11-12; widened same day after the audit found two atom-gated doors
-- that write this table and were still untagged -- "有门就要有痕").
--
-- Why a new column instead of reusing one: the allow-side record must answer "which atom gate
-- authorized this write", and no existing column can carry that without giving one column two
-- meanings (D-1028). environment stays environment.
--
-- The legal domain is the set of atom-gated doors that reach ConfigService#createAudit. It is pinned
-- by a CHECK so the enumeration cannot silently widen, and every value names the atom behind it.
ALTER TABLE config_audit ADD COLUMN atom_source VARCHAR(24);

ALTER TABLE config_audit
    ADD CONSTRAINT ck_config_audit_atom_source
    CHECK (atom_source IS NULL OR atom_source IN ('i1', 'w1', 'h1'));

COMMENT ON COLUMN config_audit.atom_source IS $cmt$
Three doors, one value each, all atom-gated: i1 = PUT /api/v1/config/instance/{domain} behind WRITE_INSTANCE_CONTENT; w1 = PUT /api/v1/config/workspace-default/{domain} behind MANAGE_WORKSPACE_DEFAULT_CONFIG; h1 = PUT /api/v1/config/workspace/{domain} behind the in-body holdsWorkspaceAtom(WRITE_WORKSPACE_CONTENT, workspaceId) check.
NULL means no capability gate was involved, and only three producers qualify: the user-layer save (PUT /api/v1/config/user/{domain}, isAuthenticated() only -- the design-ok case of D-1028), the internal template writers, and Flyway-seeded rows.
Widening this domain is a one-line migration: add the door's short id here and to ConfigController's DOOR_* constants in the same change.
$cmt$;
