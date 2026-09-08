-- PLAN-275 M1 Task 1.2: Add snapshot_id and policy_class to approval_requests
-- These columns bind approval decisions to the workspace snapshot and
-- the policy classification that triggered the approval requirement.

ALTER TABLE approval_requests
    ADD COLUMN snapshot_id UUID NULL,
    ADD COLUMN policy_class VARCHAR(32) NULL DEFAULT 'unknown';

CREATE INDEX idx_approval_requests_snapshot ON approval_requests(snapshot_id) WHERE snapshot_id IS NOT NULL;
