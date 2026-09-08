-- PLAN-276 M1 Task 1.1: Task continuity infrastructure
-- task_plans tracks a goal-oriented plan linked to a chat run and session.
-- task_items tracks individual steps within a plan with dependency and status.

CREATE TABLE task_plans (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id UUID NOT NULL,
    session_id UUID NOT NULL,
    workspace_id UUID NOT NULL,
    goal TEXT,
    current_item_id UUID,
    state VARCHAR(32) NOT NULL DEFAULT 'active',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT fk_task_plans_run FOREIGN KEY (run_id) REFERENCES chat_runs(id) ON DELETE CASCADE,
    CONSTRAINT fk_task_plans_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
    CONSTRAINT ck_task_plans_state CHECK (state IN ('active', 'completed', 'cancelled'))
);

CREATE INDEX idx_task_plans_run ON task_plans(run_id);
CREATE INDEX idx_task_plans_session ON task_plans(session_id);

CREATE TABLE task_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    task_plan_id UUID NOT NULL,
    title TEXT NOT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'pending',
    depends_on UUID NULL,
    evidence TEXT,
    position INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT fk_task_items_plan FOREIGN KEY (task_plan_id) REFERENCES task_plans(id) ON DELETE CASCADE,
    CONSTRAINT ck_task_items_status CHECK (status IN ('pending', 'in_progress', 'completed', 'blocked', 'cancelled'))
);

CREATE INDEX idx_task_items_plan ON task_items(task_plan_id);
CREATE INDEX idx_task_items_status ON task_items(status);
