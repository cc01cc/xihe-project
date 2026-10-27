-- PLAN-0559: workspace roles need EDITOR/VIEWER in addition to the legacy
-- OWNER/MEMBER values. Legacy ADMIN is kept for rows created by earlier
-- transitional code; the application canonicalizes ADMIN/MEMBER to EDITOR.
ALTER TABLE workspace_users DROP CONSTRAINT IF EXISTS ck_workspace_users_role;
ALTER TABLE workspace_users
    ADD CONSTRAINT ck_workspace_users_role
    CHECK (role IN ('OWNER', 'EDITOR', 'ADMIN', 'MEMBER', 'VIEWER'));
