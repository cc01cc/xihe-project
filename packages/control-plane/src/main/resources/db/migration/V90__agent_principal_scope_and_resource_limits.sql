-- PLAN-0622 T0.2 (M0.2): agent-principal three-tier sharing scope + model intent, and the
-- connection/model resource limits consumed by the unified ResourceGovernor.
--
-- The scope migration is a one-shot (no dual read, no compatibility layer): every pre-existing
-- principal becomes WORKSPACE, because a principal only ever became usable through a
-- workspace_agents row. The column order below is deliberate — add nullable -> backfill ->
-- NOT NULL/DEFAULT -> CHECK — so both CHECK constraints are introduced against rows that already
-- satisfy them, and so a future reader can see that the backfill guarantees
-- owner_user_id IS NULL for every backfilled row.
--
-- Limits: a NULL column means "not configured" = unlimited (backwards compatible; the governor
-- only refuses admission for limits that exist). Limits are configuration, not authoritative
-- state, so a limit change never rewrites an issued lease (in-flight work is not interrupted).
--
-- * Reversible: DROP TABLE provider_connection_model_limits, DROP the four provider_connections
--   limit columns and the agent_principals scope/model columns (with their three constraints).

-- ---------------------------------------------------------------------------
-- agent_principals: scope + owner + model intent
-- ---------------------------------------------------------------------------

ALTER TABLE agent_principals ADD COLUMN scope VARCHAR(16);
UPDATE agent_principals SET scope = 'WORKSPACE' WHERE scope IS NULL;
ALTER TABLE agent_principals ALTER COLUMN scope SET NOT NULL;
ALTER TABLE agent_principals ALTER COLUMN scope SET DEFAULT 'WORKSPACE';

-- PERSONAL agents belong to one human; the owner is the only subject who may bind or use them.
-- RESTRICT matches the surrounding FK style (workspace_agents, agent_principals.created_by_user_id):
-- deleting a user must never silently orphan a personal principal.
ALTER TABLE agent_principals ADD COLUMN owner_user_id UUID;
ALTER TABLE agent_principals
    ADD CONSTRAINT fk_agent_principals_owner_user
        FOREIGN KEY (owner_user_id) REFERENCES users (id) ON DELETE RESTRICT;

-- Model intent only: the principal never holds a provider connection (the credential is resolved
-- at run time from (user, workspace) plus the principal's own credential_use grant).
ALTER TABLE agent_principals ADD COLUMN default_model_provider TEXT;
ALTER TABLE agent_principals ADD COLUMN default_model_name TEXT;
ALTER TABLE agent_principals ADD COLUMN allowed_models JSONB;

ALTER TABLE agent_principals
    ADD CONSTRAINT ck_agent_principals_scope
        CHECK (scope IN ('PERSONAL', 'WORKSPACE', 'INSTANCE'));
ALTER TABLE agent_principals
    ADD CONSTRAINT ck_agent_principals_owner
        CHECK ((scope = 'PERSONAL' AND owner_user_id IS NOT NULL)
            OR (scope <> 'PERSONAL' AND owner_user_id IS NULL));

CREATE INDEX idx_agent_principals_scope_owner ON agent_principals (scope, owner_user_id);

-- ---------------------------------------------------------------------------
-- provider_connections + provider_connection_model_limits: resource governor configuration
-- ---------------------------------------------------------------------------

ALTER TABLE provider_connections ADD COLUMN max_inflight INT;
ALTER TABLE provider_connections ADD COLUMN max_queue INT;
ALTER TABLE provider_connections ADD COLUMN window_token_budget BIGINT;
ALTER TABLE provider_connections ADD COLUMN window_seconds INT;
ALTER TABLE provider_connections
    ADD CONSTRAINT ck_provider_connections_limits
        CHECK ((max_inflight IS NULL OR max_inflight > 0)
            AND (max_queue IS NULL OR max_queue >= 0)
            AND (window_token_budget IS NULL OR window_token_budget > 0)
            AND (window_seconds IS NULL OR window_seconds > 0));

CREATE TABLE provider_connection_model_limits (
    connection_id       UUID NOT NULL
                            REFERENCES provider_connections (id) ON DELETE CASCADE,
    provider            TEXT NOT NULL,
    model               TEXT NOT NULL,
    max_inflight        INT,
    window_token_budget BIGINT,
    window_seconds      INT,
    CONSTRAINT pk_provider_connection_model_limits
        PRIMARY KEY (connection_id, provider, model),
    CONSTRAINT ck_provider_connection_model_limits
        CHECK ((max_inflight IS NULL OR max_inflight > 0)
            AND (window_token_budget IS NULL OR window_token_budget > 0)
            AND (window_seconds IS NULL OR window_seconds > 0))
);
