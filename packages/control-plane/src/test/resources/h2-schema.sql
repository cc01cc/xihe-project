-- PLAN-0691 T2.2: H2-only shim for the two tables that have no JPA entity.
--
-- WHY THIS FILE EXISTS (read this before deleting it as a stray script):
--   * the H2 lane (application-h2.properties) does not run Flyway — it builds its schema with
--     `ddl-auto=create-drop` from the JPA entities, so a table that exists only in a migration file
--     cannot appear there;
--   * plugin_records and plugin_index_declarations are exactly that: raw-JDBC tables introduced by
--     V142 with deliberately no entity (DP-3's ledger is written by the index DDL executor, not JPA);
--   * `PluginBindingService.delete` -> `dropForBinding` SELECTs the ledger on every binding delete,
--     so without this shim every H2 test that deletes a binding answers 500.
--
-- CONSTRAINT ON THIS FILE: `spring.sql.init.mode=always` plus deferred datasource initialization run
-- it in EVERY H2 context (one shared in-memory database per process), so every statement here MUST
-- stay `CREATE TABLE IF NOT EXISTS` — anything unconditional would either fail on the second context
-- or drop another context's tables.
--
-- This file is a Java-lifecycle fixture, NOT schema evidence: H2 cannot express the PostgreSQL
-- constraints and the runtime index DDL is never exercised here. All schema claims come from
-- Testcontainers on PostgreSQL 17 (PluginRecordsIndexSchemaTest).
--
-- Types are H2 spellings of the V142 columns; keep the column names, order and constraints aligned
-- with the migration so the H2 tests fail for the same reason production would.

CREATE TABLE IF NOT EXISTS plugin_records (
    binding_id UUID NOT NULL,
    collection VARCHAR(32) NOT NULL,
    id VARCHAR(1024) NOT NULL,
    doc JSON NOT NULL,
    version BIGINT NOT NULL DEFAULT 1,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    CONSTRAINT pk_plugin_records PRIMARY KEY (binding_id, collection, id)
);

CREATE TABLE IF NOT EXISTS plugin_index_declarations (
    binding_id UUID NOT NULL,
    collection VARCHAR(32) NOT NULL,
    index_name VARCHAR(32) NOT NULL,
    fields VARCHAR(64) ARRAY NOT NULL,
    unique_flag BOOLEAN NOT NULL DEFAULT FALSE,
    state VARCHAR(16) NOT NULL DEFAULT 'pending',
    applied_at TIMESTAMP WITH TIME ZONE,
    error VARCHAR(4000),
    CONSTRAINT pk_plugin_index_declarations PRIMARY KEY (binding_id, collection, index_name),
    CONSTRAINT ck_plugin_index_declarations_state CHECK (state IN ('pending', 'applied', 'failed')),
    CONSTRAINT ck_plugin_index_declarations_fields CHECK (CARDINALITY(fields) BETWEEN 1 AND 4)
);

-- task-911: the org-unit family (V162–V167) also has no JPA entity, so create-drop cannot build it.
-- Since d9964ffc7 the workspace HTTP authorization read evaluates the org-unit grant source, so every
-- `POST /api/v1/workspaces` on this lane answered 500 (`Table "org_unit_members" not found`).
-- The read SQL is portable (`WITH RECURSIVE` over `parent_id`, see OrgUnitGrantRowsRepository), so
-- only the SHAPES are shimmed here: no ltree column, no cycle trigger, no seed rows, no subtree
-- writes. `path` is VARCHAR holding the same dotted text PostgreSQL stores as an ltree; columns
-- that the two grant reads join are exactly the ones V163/V164/V166 define.
-- Like the two tables above, every statement MUST stay `CREATE TABLE IF NOT EXISTS`.

CREATE TABLE IF NOT EXISTS org_units (
    id UUID NOT NULL,
    parent_id UUID,
    name VARCHAR(120) NOT NULL,
    path VARCHAR NOT NULL,
    depth INT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    CONSTRAINT pk_org_units PRIMARY KEY (id),
    CONSTRAINT uq_org_units_path UNIQUE (path),
    CONSTRAINT fk_org_units_parent FOREIGN KEY (parent_id) REFERENCES org_units (id)
);

CREATE TABLE IF NOT EXISTS org_unit_members (
    org_unit_id UUID NOT NULL,
    member_kind VARCHAR(16) NOT NULL,
    member_id UUID NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    CONSTRAINT pk_org_unit_members PRIMARY KEY (member_kind, member_id),
    CONSTRAINT fk_org_unit_members_unit FOREIGN KEY (org_unit_id) REFERENCES org_units (id),
    CONSTRAINT ck_org_unit_members_kind CHECK (member_kind IN ('human', 'agent_principal'))
);

CREATE TABLE IF NOT EXISTS org_unit_preset_bindings (
    id UUID NOT NULL,
    org_unit_id UUID NOT NULL,
    role_id UUID NOT NULL,
    granted_by UUID,
    granted_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    CONSTRAINT pk_org_unit_preset_bindings PRIMARY KEY (id),
    CONSTRAINT uq_org_unit_preset_bindings UNIQUE (org_unit_id, role_id),
    -- Deliberately no FK to grant_presets: that table is an Hibernate entity, and `create-drop`
    -- dropping it would then need to cascade through a shim table that outlives every context.
    -- The read only joins the columns; referential integrity for role_id stays a PostgreSQL fact.
    CONSTRAINT fk_org_unit_preset_bindings_unit FOREIGN KEY (org_unit_id) REFERENCES org_units (id)
);
