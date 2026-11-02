-- PLAN-0629 M1 (V99): the agent memory table — the durable home of D29's v1 memory
-- (types `profile` + `fact`), strictly isolated by `(principal, workspace)`.
--
-- Contract sources (frozen, do not re-litigate here):
--   * PLAN-0629 README D29-19 (writes carry provenance), D29-21 (subject-owned), D29-24
--     (no automatic writes), D29-25 (memory policy shape), D29-26/27 (passive writes may
--     only land as candidates), D29-31..34 (table/columns/indexes/constraints).
--
-- Design notes that are enforced by the database, not by service discipline:
--   1. `origin` has exactly three v1 channels — `tool`, `ui`, `cli` — and NO auto value.
--      The two passive values are pre-declared so the M2/V100 passive path needs no
--      migration; writing them is refused by the service in v1.
--   2. `status` pairs mechanically with `origin`:
--        active  <=> origin not 'passive.%'
--        candidate <=> origin like 'passive.%'
--      (two CHECKs, so "a passive write can only be a candidate" cannot be bypassed by a
--      service that forgets to set `status`).
--   3. `pinned_by` may only be `ui` or `cli` — an agent tool can never pin its own memory
--      (the mechanical form of "the agent must not hijack injection priority"). `pinned`
--      and `pinned_by` are true/false together, and only active rows may be pinned.
--   4. `content_sha256` is always computed server-side from the normalized content (single
--      normalizer: NFC -> btrim -> collapse whitespace -> drop zero-width, case preserved)
--      and is never accepted from a client.
-- Reversible: DROP TABLE agent_memories.

CREATE TABLE agent_memories (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    principal_id   UUID NOT NULL REFERENCES agent_principals (id) ON DELETE CASCADE,
    workspace_id   UUID NOT NULL REFERENCES workspaces (id) ON DELETE RESTRICT,
    type           TEXT NOT NULL CHECK (type IN ('profile', 'fact')),
    content        TEXT NOT NULL
                   CHECK (length(btrim(content)) > 0 AND length(content) <= 8000),
    -- sha256(normalized content), lowercase hex, server-computed only (D29-33).
    content_sha256 TEXT NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
    origin         TEXT NOT NULL
                   CHECK (origin IN ('tool', 'ui', 'cli', 'passive.summary', 'passive.judge')),
    -- D29-19: what this assertion came from. tool=runId, ui=userId, cli=command digest.
    -- Injected by each write channel; never taken from a request body (the tool channel
    -- must not trust model-supplied parameters).
    source_ref     TEXT NOT NULL
                   CHECK (length(btrim(source_ref)) > 0 AND length(source_ref) <= 256),
    -- V1 always writes 'active' (passive=off); 'candidate' exists for D29-26/27.
    status         TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('candidate', 'active')),
    pinned         BOOLEAN NOT NULL DEFAULT false,
    pinned_by      TEXT CHECK (pinned_by IN ('ui', 'cli')),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at     TIMESTAMPTZ,
    -- pinned 与 pinned_by 同真同假；只有 active 行可以被置顶（candidate 被 pin 是矛盾态）。
    CONSTRAINT ck_agent_memories_pin
        CHECK ((pinned AND pinned_by IS NOT NULL) OR (NOT pinned AND pinned_by IS NULL)),
    CONSTRAINT ck_agent_memories_pin_requires_active
        CHECK (NOT pinned OR status = 'active'),
    -- D29-26/27 的 DB 层不变量：主动写只能 active、被动写只能 candidate（双向）。
    CONSTRAINT ck_agent_memories_passive_status
        CHECK (status = 'active' OR origin LIKE 'passive.%'),
    CONSTRAINT ck_agent_memories_status_passive
        CHECK (origin NOT LIKE 'passive.%' OR status = 'candidate')
);

-- D29-32 dedupe: the same assertion written twice must not duplicate. A hit only refreshes
-- `updated_at`; `created_at` and `source_ref` keep the original provenance (the audit log
-- records every hit with its own channel). The partial predicate keeps soft-deleted rows out
-- of the key, so "forget then remember" works.
CREATE UNIQUE INDEX uq_agent_memories_dedupe
    ON agent_memories (principal_id, workspace_id, type, content_sha256)
    WHERE deleted_at IS NULL;

-- D29-34: strict (principal, workspace) reads in injection order (pinned first, then freshest).
-- Only active, live rows are injected in v1.
CREATE INDEX ix_agent_memories_active_injection
    ON agent_memories (principal_id, workspace_id, pinned DESC, updated_at DESC)
    WHERE deleted_at IS NULL AND status = 'active';

-- ---------------------------------------------------------------------------
-- The MEMORY_WRITE action atom (D29-24): stored in the catalog, seeded into NO default role —
-- except SUPER_ADMIN, whose definition is "every action atom" (V87 + SystemAccessRoleCatalog
-- derives it from PermissionAtomCatalog.actionAtoms()). Keeping that one row is what makes the
-- code-side catalog and the migrated rows agree (DynamicAccessRoleMigrationTest, DefaultSetMatrixTest),
-- and SUPER_ADMIN is the instance-owner root equivalent, not a "default grant" a normal account gets.
-- USER / ADMIN / WS_* deliberately do NOT receive it: an account can only use memory writes after an
-- explicit grant of MEMORY_WRITE (the mechanical form of "tool writes are denied by default").
-- Reversible: DELETE that one role_permissions row.
-- ---------------------------------------------------------------------------
INSERT INTO role_permissions (role_id, action_class, resource_pattern) VALUES
    ('00000000-0000-4000-8000-000000000001', 'MEMORY_WRITE', '*')
ON CONFLICT (role_id, action_class, resource_pattern) DO NOTHING;