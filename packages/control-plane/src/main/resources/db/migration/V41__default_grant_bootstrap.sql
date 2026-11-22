-- PLAN-0407 T2.4: materialize the default source through the common grants path.

WITH default_subjects AS (
    SELECT 'user'::VARCHAR(24) AS subject_type, u.id AS subject_id, u.role AS user_role
    FROM users u

    UNION ALL

    SELECT 'agent'::VARCHAR(24) AS subject_type, s.id AS subject_id, u.role AS user_role
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.kind IS NULL
),
inserted_grants AS (
    INSERT INTO grants (
        id, granter_type, granter_id, subject_type, subject_id,
        permissions, source, created_at, read_state
    )
    SELECT
        gen_random_uuid(), NULL, NULL, subject_type, subject_id,
        CASE WHEN user_role = 'ADMIN'
            THEN '[{"actionClass":"read"},{"actionClass":"write"},{"actionClass":"delete"},{"actionClass":"exec"},{"actionClass":"network"},{"actionClass":"credential"}]'::JSONB
            ELSE '[{"actionClass":"read"},{"actionClass":"write"},{"actionClass":"delete"},{"actionClass":"exec"},{"actionClass":"network"}]'::JSONB
        END,
        'default', NOW(), 'read'
    FROM default_subjects
    ON CONFLICT (subject_type, subject_id) WHERE source = 'default' DO NOTHING
    RETURNING id, subject_type, subject_id, created_at
)
INSERT INTO audit_logs (
    id, user_id, workspace_id, action, resource_type, resource_id, details, created_at
)
SELECT
    gen_random_uuid(), NULL, NULL, 'authorization_default_grant_backfilled', 'grant', id::TEXT,
    jsonb_build_object('source', 'default', 'subjectType', subject_type, 'subjectId', subject_id)::TEXT,
    created_at
FROM inserted_grants;
