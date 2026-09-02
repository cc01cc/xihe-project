-- The old table stored a desired execution specification, not a scheduler binding.
DO $$
BEGIN
    IF to_regclass('public.workspace_assignments') IS NOT NULL
       AND to_regclass('public.workspace_execution_specs') IS NULL THEN
        ALTER TABLE workspace_assignments RENAME TO workspace_execution_specs;
    END IF;
END $$;

DO $$
BEGIN
    IF to_regclass('public.workspace_execution_specs') IS NOT NULL
       AND to_regclass('public.idx_workspace_assignments_workspace_generation') IS NOT NULL THEN
        ALTER INDEX idx_workspace_assignments_workspace_generation
            RENAME TO idx_workspace_execution_specs_workspace_generation;
    END IF;
    IF to_regclass('public.workspace_execution_specs') IS NOT NULL
       AND to_regclass('public.uq_workspace_assignments_workspace_generation') IS NOT NULL THEN
        ALTER INDEX uq_workspace_assignments_workspace_generation
            RENAME TO uq_workspace_execution_specs_workspace_generation;
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS workspace_execution_specs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id VARCHAR(36) NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    generation INT NOT NULL,
    sandbox_spec_hash VARCHAR(64) NOT NULL,
    sandbox_spec JSONB NOT NULL,
    storage_backend VARCHAR(32) NOT NULL DEFAULT 'host_directory',
    storage_ref VARCHAR(64) NOT NULL,
    actor VARCHAR(255),
    reason VARCHAR(512),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_workspace_execution_specs_workspace_generation
    ON workspace_execution_specs(workspace_id, generation);

CREATE UNIQUE INDEX IF NOT EXISTS uq_workspace_execution_specs_workspace_generation
    ON workspace_execution_specs(workspace_id, generation);
