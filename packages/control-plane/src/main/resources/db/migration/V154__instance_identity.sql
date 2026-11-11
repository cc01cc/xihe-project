-- D-935 / PLAN-0767 M1-3: the deployment identity singleton.
-- The row is created by the first-boot seeding transaction (InstanceIdentityInitializer), not by
-- this migration: a migration cannot know XIHE_DEPLOYMENT_ID, and hard-coding a value would make
-- every later env comparison fail-fast. The singleton id + CHECK keeps "exactly one row" in the DB.
CREATE TABLE instance_identity (
    id          SMALLINT    NOT NULL,
    instance_id UUID        NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT pk_instance_identity PRIMARY KEY (id),
    CONSTRAINT ck_instance_identity_singleton CHECK (id = 1),
    CONSTRAINT uq_instance_identity_instance UNIQUE (instance_id)
);
