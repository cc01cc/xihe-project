-- PLAN-0489（contract: PLAN-0486 spec/scheduled-task.md v3.4 §1 agent_principal_id,
-- 用户裁定 2026-10-11「加 V60 列」）: scheduled_tasks 创建者归属列。
-- AgentPrincipal 无独立 users 行，仅 user_id 无法回溯创建者是否 agent；镜像
-- sessions.agent_principal_id（V42）模式：加列 + 部分索引（agent 创建的任务
-- 列表/详情按创建者回查）。
-- FK 用 ON DELETE SET NULL（区别于 sessions 的 RESTRICT：本列是历史归属而非活绑定，
-- agent principal 删除后任务保留、读端 createdBy 降级 human）。新表无回填。
--
-- 回滚：DROP INDEX idx_scheduled_tasks_creator_principal;
--       ALTER TABLE scheduled_tasks DROP COLUMN agent_principal_id;
--       （回滚前需先撤下按 agent_principal_id 派生 createdBy 的读端逻辑。）

ALTER TABLE scheduled_tasks
    ADD COLUMN agent_principal_id UUID REFERENCES agent_principals (id) ON DELETE SET NULL;

CREATE INDEX idx_scheduled_tasks_creator_principal
    ON scheduled_tasks (agent_principal_id, created_at DESC)
    WHERE agent_principal_id IS NOT NULL;
