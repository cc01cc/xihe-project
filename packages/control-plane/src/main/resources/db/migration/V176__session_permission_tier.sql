-- D-1908 rev4 (task-107): the session permission tier becomes the source of truth for how much a
-- run inside one session may do. sessions.approval_mode is DERIVED from it
-- (view/workspace -> manual, full -> auto) and stays readable for older rows; never the reverse.
ALTER TABLE sessions ADD COLUMN permission_tier VARCHAR(16);

ALTER TABLE sessions ADD CONSTRAINT ck_sessions_permission_tier
    CHECK (permission_tier IS NULL OR permission_tier IN ('view', 'workspace', 'full'));

COMMENT ON COLUMN sessions.permission_tier IS
    'D-1908: view|workspace|full; NULL = inherit the workspace policy. Source of truth for sessions.approval_mode.';

-- Backfill keeps the pre-V176 behaviour: an auto session stays auto (=> full), a manual session
-- stays manual (=> workspace). "manual -> workspace" is deliberate rather than "manual -> view":
-- both derive manual approval, but view would ALSO shrink the session's write scope to read-only,
-- which the old column never expressed. Do not "simplify" this into an equivalent-looking mapping.
-- D-215 exception (explicit): sessions.approval_mode is real existing data, not dev-time scaffolding.
-- Dropping this backfill would leave every tier NULL => every session inherits the workspace default
-- => existing manual sessions get silently relaxed, which is exactly what D-1908 forbids.
UPDATE sessions SET permission_tier = 'full'      WHERE approval_mode = 'auto';
UPDATE sessions SET permission_tier = 'workspace' WHERE approval_mode = 'manual';
