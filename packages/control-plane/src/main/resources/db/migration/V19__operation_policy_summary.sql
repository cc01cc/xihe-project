-- PLAN-0328 T1.15: safe policy verdict snapshot attached to the dispatch ledger item.
-- Nullable for pre-V19 rows; never carries raw arguments or request bodies.
ALTER TABLE operation_items ADD COLUMN policy_summary TEXT;
