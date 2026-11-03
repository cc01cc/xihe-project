-- PLAN-0639 M1 (V104): add roots column to workspace_execution_specs.
--
-- The WorkspaceExecutionSpec entity gained a `roots` JSONB column (PLAN-0639 M1)
-- but the Flyway migration was missed, causing Hibernate schema-validation failures
-- across 110+ test classes (missing column [roots] in table [workspace_execution_specs]).
--
-- Reversible: ALTER TABLE workspace_execution_specs DROP COLUMN roots;

ALTER TABLE workspace_execution_specs ADD COLUMN roots JSONB;
