-- PLAN-294 M1 (decision #13): chat runs persist their token usage as an
-- llm_usage operation item (one per run) carrying the estimated/real counts
-- and the source tag as an extension. Widen the kind CHECK additively.
ALTER TABLE operation_items DROP CONSTRAINT ck_operation_items_kind;
ALTER TABLE operation_items ADD CONSTRAINT ck_operation_items_kind
    CHECK (kind IN ('chat', 'tool_call', 'approval', 'job', 'workspace_lifecycle', 'system', 'other', 'llm_usage'));
