-- PLAN-0328 R4: retain the effective session mode captured by the decision transition.
ALTER TABLE approval_requests ADD COLUMN mode_at_grant VARCHAR(32);
