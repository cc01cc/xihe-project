-- PLAN-0691 T2.2: H2-only shim for the two tables that have no JPA entity.
--
-- The H2 lane (application-h2.properties) does not run Flyway: it builds its schema with
-- `ddl-auto=create-drop` from the JPA entities, so a table that only exists in a migration file
-- cannot appear there. plugin_records and plugin_index_declarations are exactly that — raw-JDBC
-- tables introduced by V142, deliberately without an entity (DP-3's ledger is written by the index
-- executor, not by JPA). Without this shim, `PluginBindingService.delete` -> `dropForBinding` fails on
-- the ledger SELECT and every H2 test that deletes a binding gets a 500.
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
