-- PLAN-0340 decision #10: clear legacy single-key source hashes.
-- Session L1 state lives in event projection (context.source_changed); no migration.
DELETE FROM context_source_hashes;
