ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_workspaces_owner_active
    ON workspaces(owner_id, created_at)
    WHERE deleted_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_workspaces_active_owner
    ON workspaces(owner_id)
    WHERE deleted_at IS NULL;

DO $$
DECLARE
    constraint_name TEXT;
BEGIN
    FOR constraint_name IN
        SELECT tc.constraint_name
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON kcu.constraint_name = tc.constraint_name
         AND kcu.table_schema = tc.table_schema
        WHERE tc.table_schema = current_schema()
          AND tc.table_name = 'messages'
          AND tc.constraint_type = 'FOREIGN KEY'
          AND kcu.column_name = 'session_id'
    LOOP
        EXECUTE format('ALTER TABLE messages DROP CONSTRAINT %I', constraint_name);
    END LOOP;
    ALTER TABLE messages
        ADD CONSTRAINT fk_messages_session
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE;
END $$;

DO $$
DECLARE
    constraint_name TEXT;
BEGIN
    FOR constraint_name IN
        SELECT tc.constraint_name
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON kcu.constraint_name = tc.constraint_name
         AND kcu.table_schema = tc.table_schema
        WHERE tc.table_schema = current_schema()
          AND tc.table_name = 'context_events'
          AND tc.constraint_type = 'FOREIGN KEY'
          AND kcu.column_name = 'session_id'
    LOOP
        EXECUTE format('ALTER TABLE context_events DROP CONSTRAINT %I', constraint_name);
    END LOOP;
    ALTER TABLE context_events
        ADD CONSTRAINT fk_context_events_session
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE;
END $$;

DO $$
DECLARE
    constraint_name TEXT;
BEGIN
    FOR constraint_name IN
        SELECT tc.constraint_name
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON kcu.constraint_name = tc.constraint_name
         AND kcu.table_schema = tc.table_schema
        WHERE tc.table_schema = current_schema()
          AND tc.table_name = 'context_projections'
          AND tc.constraint_type = 'FOREIGN KEY'
          AND kcu.column_name = 'session_id'
    LOOP
        EXECUTE format('ALTER TABLE context_projections DROP CONSTRAINT %I', constraint_name);
    END LOOP;
    ALTER TABLE context_projections
        ADD CONSTRAINT fk_context_projections_session
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE;
END $$;

CREATE INDEX IF NOT EXISTS idx_sessions_workspace_user_active
    ON sessions(workspace_id, user_id, archived, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_workspace_users_user_workspace
    ON workspace_users(user_id, workspace_id);
