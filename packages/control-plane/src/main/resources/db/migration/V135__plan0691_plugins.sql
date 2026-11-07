-- PLAN-0691 T1.1 manifest registry (review round-2 §45).
--
-- Pure additive: no existing table, column or index is touched. Numbering per the
-- frozen round-2 order: develop's max applied migration is V134 (PLAN-0690),
-- V135 belongs to this lane; V136+ stay reserved for the later M1 tasks.
--
-- D-65 (S-2) fixes the shape: (id, digest) is the primary key, versions co-exist
-- per plugin, and exactly one row per plugin may carry is_current. The partial
-- unique index is the DB backstop for that rule; serialization of install/upgrade
-- is done by the service layer with a per-plugin transaction advisory lock.
CREATE TABLE plugins (
    id         VARCHAR(128) NOT NULL,
    digest     VARCHAR(80)  NOT NULL,
    version    VARCHAR(64)  NOT NULL,
    -- Lifecycle state: 'enabled' | 'disabled' (fail-closed default; enable is explicit).
    state      VARCHAR(16)  NOT NULL DEFAULT 'disabled',
    -- Package origin: 'builtin' (plugins/official/) | 'third-party' (plugins/local/).
    source     VARCHAR(16)  NOT NULL,
    manifest   JSONB        NOT NULL,
    is_current BOOLEAN      NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ  NOT NULL DEFAULT now(),
    CONSTRAINT pk_plugins PRIMARY KEY (id, digest),
    CONSTRAINT ck_plugins_manifest_object CHECK (jsonb_typeof(manifest) = 'object')
);

-- D-65: at most one current version per plugin id.
CREATE UNIQUE INDEX ux_plugins_current ON plugins (id) WHERE is_current;
