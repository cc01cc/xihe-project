-- PLAN-0691 T2.2 (V142): plugin_records + the index-declaration ledger.
--
-- Number: this migration was drafted as 140. Sibling lane's V141 (plugin_kv) reached develop first,
-- and this repo runs Flyway with outOfOrder=false, so a 140 merged afterwards would abort every
-- already-migrated database with "Detected resolved migration not applied to database: 140". The Lead
-- therefore re-assigned the number: this file is V142, and 140 is permanently retired — never reuse
-- it. Only the number changed; the DDL below is exactly as reviewed.
--
-- Authority: spec/data-plane.md DP-2 (records), DP-3 (ledger), DP-6/DP-6a (no database FK on
-- binding_id), LC-6 (the ledger survives uninstall and purge), QUOTA-8 (per-collection index budget).
--
-- Migration number: assigned by the Lead (V142). Do not renumber — V139 is already merged and a
-- sibling lane owns V141 (renumbered from V138), because two lanes picking "current max + 1" at merge
-- time is how numbers collide.
--
-- 宽限期语义按 DP-6a；`orphaned_at` 未建，purge 用 `updated_at` 回退。
--
-- DP-6a: binding_id is a plain NOT NULL column and deliberately carries NO foreign key. A binding
-- row is deleted physically on uninstall, while LC-6 (records live through a 7-day grace period) and
-- DP-3 (the ledger is never removed) require this data to outlive it. ON DELETE CASCADE would delete
-- user records on uninstall, RESTRICT would block uninstall outright; both re-freeze already frozen
-- clauses (V6/LC-6). The grace period therefore lives on "orphan rows outlive their binding" and
-- T3.2's purge job reaps them by "binding_id no longer present in plugin_bindings".
--
-- DP-6a's wording mentions an `orphaned_at` column that DP-2 does NOT list. It is deliberately not
-- created: the purge job falls back to `updated_at` (DP-6a: "未写入时回退 updated_at"), and adding a
-- second clock now would mean maintaining it before T3.2 exists to consume it.
--
-- Declared indexes are NOT created here. spec §8 (Flyway rule): index DDL runs at runtime from the
-- CP executor and only the ledger rows are persisted here, so an install that fails mid-DDL leaves
-- no index behind (LC-8) while the audit trail still records the attempt.

CREATE TABLE plugin_records (
    -- No FK, see DP-6a above.
    binding_id UUID        NOT NULL,
    -- Manifest collection name (spec/manifest.schema.json $defs/collection: max 32 chars).
    collection VARCHAR(32) NOT NULL,
    -- Record id. The wire format is still open (spec §11 item 2: ULID vs UUIDv7), so the column is
    -- TEXT instead of a width that would have to be migrated the day that is decided.
    id         TEXT        NOT NULL,
    doc        JSONB       NOT NULL,
    -- Optimistic-concurrency counter; DP-7: CP is the only writer and the only sequence.
    version    BIGINT      NOT NULL DEFAULT 1,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT pk_plugin_records PRIMARY KEY (binding_id, collection, id)
);

-- The primary key already indexes (binding_id, ...) as a prefix, which is what the purge job's
-- "binding_id = ?" sweep and the per-binding index predicates need; no separate index (checklist F).

CREATE TABLE plugin_index_declarations (
    binding_id  UUID        NOT NULL,
    collection  VARCHAR(32) NOT NULL,
    index_name  VARCHAR(32) NOT NULL,
    -- Manifest-declared fields, in declaration order; they become the expression list of the
    -- physical index. Cardinality matches the frozen schema (index.fields: minItems 1, maxItems 4).
    fields      TEXT[]      NOT NULL,
    unique_flag BOOLEAN     NOT NULL DEFAULT FALSE,
    -- DP-3 state vocabulary. 'pending' is available for a stepper (e.g. a concurrent index build)
    -- but the current writer records only the terminal state inside the install transaction plus a
    -- 'failed' row in its own transaction, because a rolled-back install must not leave a 'pending'
    -- row behind claiming work that never happened. A declaration refused before any DDL (QUOTA-8:
    -- illegal segment, zero fields, more than four) gets NO row — the CHECK below cannot represent a
    -- zero-field declaration, and that refusal is durably audited (audit_logs result=rejected).
    state       VARCHAR(16) NOT NULL DEFAULT 'pending',
    applied_at  TIMESTAMPTZ,
    error       TEXT,
    CONSTRAINT pk_plugin_index_declarations PRIMARY KEY (binding_id, collection, index_name),
    CONSTRAINT ck_plugin_index_declarations_state
        CHECK (state IN ('pending', 'applied', 'failed')),
    CONSTRAINT ck_plugin_index_declarations_fields
        CHECK (cardinality(fields) BETWEEN 1 AND 4)
);
