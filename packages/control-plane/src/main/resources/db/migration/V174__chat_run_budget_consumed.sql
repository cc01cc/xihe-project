-- task-101 (B, D-1869①): the budget-charged amount, recorded NEXT TO the real
-- provider consumption in chat_runs.token_count. NULL (not 0) is the honest value
-- for every row that predates this column: 0 would read as "this run spent nothing".
ALTER TABLE chat_runs ADD COLUMN budget_consumed BIGINT NULL;
