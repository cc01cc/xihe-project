-- PLAN-0690 T2.1 (D-215): roster-level default delivery roles.
-- Frozen shape (Lead 2026-11-07): TEXT[] + named CHECK, subset of {to,cc,mention_only},
-- distinct, and one-dimensional (D-70).
-- Additive and nullable: no backfill and no dual-read — development data may be discarded per D-215.
ALTER TABLE session_participants
    ADD COLUMN delivery_defaults TEXT[] NULL;

ALTER TABLE session_participants
    ADD CONSTRAINT ck_session_participants_delivery_defaults
    CHECK (
        delivery_defaults IS NULL
        OR (
            delivery_defaults <@ ARRAY['to', 'cc', 'mention_only']::TEXT[]
            -- array_ndims is NULL for the zero-dimensional empty array, so both branches stay.
            AND (array_ndims(delivery_defaults) IS NULL OR array_ndims(delivery_defaults) = 1)
            AND array_position(delivery_defaults, NULL::TEXT) IS NULL
            AND cardinality(array_positions(delivery_defaults, 'to')) <= 1
            AND cardinality(array_positions(delivery_defaults, 'cc')) <= 1
            AND cardinality(array_positions(delivery_defaults, 'mention_only')) <= 1
        )
    );
