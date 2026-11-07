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
