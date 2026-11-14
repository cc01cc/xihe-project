-- V168 (task-517): roots uniqueness must fold path separators, not only case.
--
-- Precondition measured on the stack-1 dev database (xihe_1) immediately before writing this file
-- (readings expire; re-run before applying anywhere else):
--   DUP_IDX_EXPR = 0 duplicate groups under (workspace_id, lower(replace(host_path,'\','/'))),
--   TRAILING    = 0,  active roots = 6  => the constraint can be built without data cleanup.
--
-- The pre-existing uq_workspace_roots_active_path only applies lower(host_path), so 'h:\a' and
-- 'h:/a' are two distinct keys and ONE physical directory could be stored as two rows. This index
-- folds separators too; it is strictly stronger (every pair rejected by the old index is also
-- rejected by this one), so the old index becomes redundant but is left in place.
CREATE UNIQUE INDEX uq_workspace_roots_active_lexical
    ON workspace_roots (workspace_id, lower(replace(host_path, '\', '/')))
    WHERE deleted_at IS NULL;
