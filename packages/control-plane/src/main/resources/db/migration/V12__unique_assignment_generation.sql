CREATE UNIQUE INDEX IF NOT EXISTS uq_workspace_assignments_workspace_generation
    ON workspace_assignments(workspace_id, generation);
