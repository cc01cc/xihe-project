-- PLAN-271/P275: consume each approved policy grant at most once.
ALTER TABLE approval_requests
    ADD COLUMN grant_consumed_at TIMESTAMPTZ;

CREATE INDEX idx_approval_requests_grant_consumption
    ON approval_requests (request_id, state, grant_consumed_at);
