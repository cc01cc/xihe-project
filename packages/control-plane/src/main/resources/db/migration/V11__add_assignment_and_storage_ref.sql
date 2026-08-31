-- M2-3.2 & P200 Q4/Q5/Q12: independent assignment table with generation/hash and storageRef
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS storage_backend VARCHAR(32) DEFAULT 'host_directory';
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS storage_ref VARCHAR(64);
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS generation INT DEFAULT 0;
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS sandbox_spec_hash VARCHAR(64);
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS sandbox_spec JSONB;

-- Backfill storage_ref from storage_path basename for existing rows (if any)
UPDATE workspaces SET storage_ref = substring(storage_path from '[^/\\]+$') WHERE storage_ref IS NULL AND storage_path IS NOT NULL;

CREATE TABLE IF NOT EXISTS workspace_assignments (
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
CREATE INDEX IF NOT EXISTS idx_workspace_assignments_workspace_generation ON workspace_assignments(workspace_id, generation);
