-- V180 (task-124 / DSD-1509): session-level temporary capability tokens.
--
-- Why a table of its own instead of reusing grants: grants.scope_type is constrained to
-- instance/workspace by ck_grants_scope and fk_grants_scope_workspace points scope_id at
-- workspaces(id) ON DELETE CASCADE (V87:67-76), so scope_id can never hold a session id without
-- dropping that cascade. grants is also read/written by consumers that ignore scope on purpose
-- (AuthorizationGrantRepository.deleteBySubjectTypeAndSubjectId, RoleGrantMaterializer's per-source
-- reconciliation), which would silently delete or overwrite temporary rows. A separate table keeps
-- the standing-grant invariants untouched.
--
-- Semantics (DSD-1509, ruled by the lead on 2026-11-20): a live row is a capability token for ONE
-- session and ONE agent principal. For the (actionClass, resource) pairs it covers it replaces the
-- "does every level hold this atom" test; atoms it does not cover are still intersected level by
-- level. It is not a sixth evaluation level and it can never widen an atom the grantor does not hold
-- (the creation face refuses those; see SessionTemporaryGrantService).
--
-- Expiry is data, not a job: every read filters "expires_at > now() AND revoked_at IS NULL", so an
-- expired row is absent the next time it is looked at and no @Scheduled sweep is required. The rows
-- that linger after expiry are inert and disappear with the session (fk_stg_session ON DELETE
-- CASCADE), which is the "session ends => grant cleanup" half of DSD-1500 R4.
--
-- Rollback (this repo keeps forward-only migrations): DROP TABLE session_temporary_grants removes the
-- table and both indexes; nothing else references it, so V179's shape comes back without residue.
-- The token is additive -- with no rows every decision is exactly the pre-task-124 decision.

CREATE TABLE session_temporary_grants (
    id                 UUID        PRIMARY KEY,
    session_id         UUID        NOT NULL,
    workspace_id       UUID        NOT NULL,
    principal_id       UUID        NOT NULL,
    permissions        JSONB       NOT NULL,
    granted_by_user_id UUID        NOT NULL,
    granted_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at         TIMESTAMPTZ NOT NULL,
    revoked_at         TIMESTAMPTZ,
    revoked_by_user_id UUID,
    CONSTRAINT fk_stg_session FOREIGN KEY (session_id) REFERENCES sessions (id) ON DELETE CASCADE,
    CONSTRAINT fk_stg_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE CASCADE,
    CONSTRAINT fk_stg_principal FOREIGN KEY (principal_id) REFERENCES agent_principals (id) ON DELETE CASCADE,
    CONSTRAINT fk_stg_granted_by FOREIGN KEY (granted_by_user_id) REFERENCES users (id),
    CONSTRAINT fk_stg_revoked_by FOREIGN KEY (revoked_by_user_id) REFERENCES users (id),
    CONSTRAINT ck_stg_expiry CHECK (expires_at > granted_at),
    CONSTRAINT ck_stg_revocation CHECK ((revoked_at IS NULL) = (revoked_by_user_id IS NULL))
);

-- The hot path is GrantAuthorizationService: (session, principal) of the leaf session, live rows only.
CREATE INDEX idx_stg_live
    ON session_temporary_grants (session_id, principal_id, expires_at)
    WHERE revoked_at IS NULL;

-- The read face lists one session's tokens (GET .../temporary-grants).
CREATE INDEX idx_stg_session
    ON session_temporary_grants (session_id, granted_at DESC);

COMMENT ON TABLE session_temporary_grants IS
    'task-124 / DSD-1509: session-scoped temporary capability tokens (exec-sensitive paths). Live rows are a session-only override of the per-level atom holding test; expiry and revocation are filtered in SQL, never by a scheduled sweep.';
COMMENT ON COLUMN session_temporary_grants.permissions IS
    'Atom array in the grants.permissions shape: [{actionClass, resource?}]. resource is matched with the same matcher grants use (ResourceIdentity for fs: declaration keys, LayeredPolicyResolver otherwise).';
COMMENT ON COLUMN session_temporary_grants.expires_at IS
    'Hard TTL: the row authorizes nothing at or after this instant (SQL predicate, no clock-dependent job). Bounded to 60s..8h by the creation face.';
COMMENT ON COLUMN session_temporary_grants.revoked_at IS
    'Set by DELETE .../temporary-grants/{grantId}; a revoked row authorizes nothing from the same transaction on (the evaluation read is uncached).';
COMMENT ON COLUMN session_temporary_grants.principal_id IS
    'Leaf agent principal the token was issued to; a token never follows a delegation to another principal (leaf-only, DSD-1509 G3).';
