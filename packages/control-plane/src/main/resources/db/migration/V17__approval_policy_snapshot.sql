-- PLAN-0328 T1.13: retain the policy evidence captured when an approval is created.
ALTER TABLE approval_requests ADD COLUMN policy_summary TEXT;
