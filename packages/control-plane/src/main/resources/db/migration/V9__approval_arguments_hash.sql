-- PLAN-292 M1 (task 1.3): store the Agent-produced canonical arguments hash
-- on approval rows so grant consumption matches by hash instead of parsing
-- the truncated preview JSON (large-content write_file used to 409 after
-- approval). Nullable: rows created before this migration keep legacy
-- preview-JSON matching (fail-closed).
ALTER TABLE approval_requests
    ADD COLUMN arguments_hash VARCHAR(96);
