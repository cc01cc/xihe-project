CREATE TABLE agent_principals (
    id UUID PRIMARY KEY,
    name TEXT NOT NULL,
    template_id TEXT,
    template_snapshot JSONB,
    created_by_user_id UUID NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    disabled_at TIMESTAMPTZ,
    CONSTRAINT fk_agent_principals_created_by_user
        FOREIGN KEY (created_by_user_id) REFERENCES users (id) ON DELETE RESTRICT
);

CREATE INDEX idx_agent_principals_created_by_user
    ON agent_principals (created_by_user_id);

CREATE TABLE workspace_agents (
    principal_id UUID NOT NULL,
    workspace_id UUID NOT NULL,
    permissions_snapshot JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT pk_workspace_agents PRIMARY KEY (principal_id, workspace_id),
    CONSTRAINT fk_workspace_agents_principal
        FOREIGN KEY (principal_id) REFERENCES agent_principals (id) ON DELETE RESTRICT,
    CONSTRAINT fk_workspace_agents_workspace
        FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE RESTRICT
);

CREATE INDEX idx_workspace_agents_workspace_id
    ON workspace_agents (workspace_id);

ALTER TABLE sessions
    ADD COLUMN agent_principal_id UUID,
    ADD COLUMN agent_permissions_snapshot JSONB,
    ADD CONSTRAINT fk_sessions_agent_principal
        FOREIGN KEY (agent_principal_id) REFERENCES agent_principals (id) ON DELETE RESTRICT;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM sessions
        WHERE kind IS NOT NULL
           OR spawned_from_session_id IS NOT NULL
           OR spawned_from_run_id IS NOT NULL
           OR spawned_at IS NOT NULL
    ) THEN
        RAISE EXCEPTION 'V42 cannot backfill pre-existing derived Sessions; preserve data and resolve provenance first';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM chat_runs cr
        JOIN sessions s ON s.id = cr.session_id
        WHERE cr.origin <> 'user_submission'
           OR cr.user_id <> s.user_id
           OR cr.workspace_id <> s.workspace_id
    ) THEN
        RAISE EXCEPTION 'V42 legacy ChatRun source/owner/workspace is not a root user submission';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM grants g
        LEFT JOIN sessions s ON s.id = g.subject_id
        WHERE g.subject_type = 'agent'
          AND (s.id IS NULL OR g.source <> 'default')
    ) THEN
        RAISE EXCEPTION 'V42 found an unmapped non-default or orphan Agent grant';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM sessions s
        JOIN chat_runs cr ON cr.session_id = s.id
        LEFT JOIN grants g
          ON g.subject_type = 'agent' AND g.subject_id = s.id AND g.source = 'default'
        GROUP BY s.id
        HAVING COUNT(DISTINCT g.id) <> 1
    ) THEN
        RAISE EXCEPTION 'V42 requires exactly one root default Agent grant for every ChatRun Session';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM grants g
        WHERE g.source = 'default'
          AND (
              (g.subject_type = 'agent'
                  AND EXISTS (SELECT 1 FROM chat_runs cr WHERE cr.session_id = g.subject_id))
              OR (g.subject_type = 'user'
                  AND EXISTS (
                      SELECT 1 FROM chat_runs cr
                      JOIN sessions s ON s.id = cr.session_id
                      WHERE s.user_id = g.subject_id
                  ))
          )
          AND (
              jsonb_typeof(g.permissions) <> 'array'
              OR EXISTS (
                  SELECT 1
                  FROM jsonb_array_elements(
                      CASE WHEN jsonb_typeof(g.permissions) = 'array' THEN g.permissions ELSE '[]'::jsonb END
                  ) atom
                  WHERE jsonb_typeof(atom) <> 'object'
                     OR atom - 'actionClass' - 'resource' <> '{}'::jsonb
                     OR jsonb_typeof(atom->'actionClass') IS DISTINCT FROM 'string'
                     OR COALESCE(atom->>'actionClass', '') NOT IN ('read', 'write', 'delete', 'exec', 'network', 'credential')
                     OR (atom ? 'resource' AND jsonb_typeof(atom->'resource') <> 'string')
              )
          )
    ) THEN
        RAISE EXCEPTION 'V42 encountered an invalid legacy default User or Agent permission atom';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM sessions s
        JOIN chat_runs cr ON cr.session_id = s.id
        JOIN grants agent_grant
          ON agent_grant.subject_type = 'agent'
         AND agent_grant.subject_id = s.id
         AND agent_grant.source = 'default'
        LEFT JOIN grants user_grant
          ON user_grant.subject_type = 'user'
         AND user_grant.subject_id = s.user_id
         AND user_grant.source = 'default'
        WHERE user_grant.id IS NULL
           OR NOT (user_grant.permissions @> agent_grant.permissions)
    ) THEN
        RAISE EXCEPTION 'V42 Agent default grants exceed the legacy owner User default grant';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM chat_runs cr
        JOIN sessions s ON s.id = cr.session_id
        LEFT JOIN workspace_users wu
          ON wu.workspace_id = s.workspace_id AND wu.user_id = s.user_id
        WHERE wu.user_id IS NULL
    ) THEN
        RAISE EXCEPTION 'V42 cannot bind an Agent principal outside the Session owner Workspace membership';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM context_events ce
        WHERE ce.correlation_id IS NOT NULL
          AND NOT EXISTS (
              SELECT 1
              FROM chat_runs cr
              WHERE cr.id::text = ce.correlation_id
                AND cr.session_id = ce.session_id
          )
    ) THEN
        RAISE EXCEPTION 'V42 found a ContextEvent correlation that does not identify a ChatRun in the same Session';
    END IF;
END
$$;

CREATE TEMP TABLE v42_agent_principal_backfill ON COMMIT DROP AS
SELECT s.id AS session_id,
       gen_random_uuid() AS principal_id,
       s.user_id,
       s.workspace_id,
       s.title,
       s.created_at,
       g.id AS grant_id,
       g.permissions
FROM sessions s
JOIN grants g
  ON g.subject_type = 'agent' AND g.subject_id = s.id AND g.source = 'default'
WHERE EXISTS (SELECT 1 FROM chat_runs cr WHERE cr.session_id = s.id);

ALTER TABLE v42_agent_principal_backfill
    ADD PRIMARY KEY (session_id),
    ADD UNIQUE (principal_id),
    ADD UNIQUE (grant_id);

INSERT INTO agent_principals (id, name, created_by_user_id, created_at)
SELECT principal_id,
       COALESCE(NULLIF(BTRIM(title), ''), 'Agent ' || LEFT(session_id::text, 8)),
       user_id,
       created_at
FROM v42_agent_principal_backfill;

INSERT INTO workspace_agents (principal_id, workspace_id, permissions_snapshot, created_at)
SELECT principal_id, workspace_id, permissions, created_at
FROM v42_agent_principal_backfill;

INSERT INTO audit_logs (id, user_id, workspace_id, action, resource_type, resource_id, details, created_at)
SELECT gen_random_uuid(),
       NULL,
       workspace_id,
       'agent_principal_backfilled',
       'agent_principal',
       principal_id::text,
       jsonb_build_object(
           'source', 'V42',
           'sessionId', session_id::text,
           'grantId', grant_id::text
       )::text,
       NOW()
FROM v42_agent_principal_backfill;

UPDATE sessions s
SET agent_principal_id = b.principal_id,
    agent_permissions_snapshot = b.permissions
FROM v42_agent_principal_backfill b
WHERE s.id = b.session_id;

UPDATE grants g
SET subject_type = 'agent_principal',
    subject_id = b.principal_id
FROM v42_agent_principal_backfill b
WHERE g.id = b.grant_id;

DELETE FROM grants g
WHERE g.subject_type = 'agent'
  AND g.source = 'default'
  AND NOT EXISTS (
      SELECT 1 FROM chat_runs cr WHERE cr.session_id = g.subject_id
  );

CREATE INDEX idx_sessions_agent_principal_id
    ON sessions (agent_principal_id, created_at DESC)
    WHERE agent_principal_id IS NOT NULL;
