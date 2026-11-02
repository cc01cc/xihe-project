-- PLAN-0628 M1 (V101): skills library + two-axis bindings.
--
-- Contract sources (frozen, do not re-litigate here):
--   * PLAN-0628 README D28-14 (two axes = role_bindings V87:40-61, NULLS NOT DISTINCT key),
--     D28-15 (oversize flag, never reject/truncate), D28-16 (listing is its own budget block),
--     D28-17 (v1 import is explicit/manual), D28-21 (attachments = manifest only),
--     README frozen #4 (same name may coexist: qualified display names, never silent overwrite).
--   * Budget arithmetic lives ONLY in packages/agent/.../context/injection_budget.py (D27-22).
--
-- Deliberately absent: chat_runs.skills_snapshot (D28-20 = M2; that column takes the NEXT free
-- number at merge time — this repo does not reserve numbers, out-of-order is off),
-- skills.disabled_at (no writer in M1), skills.origin (v1 has one import channel), trusted_source
-- (derivable from definition_scope_type).
-- Reversible: DROP TABLE skill_bindings; DROP TABLE skills;  (no other object touched)

CREATE TABLE skills (
    id                    UUID PRIMARY KEY,
    -- frontmatter `name`; lowercase kebab; must equal the source directory name (checked at
    -- import, CP side, from source_path). ':' is forbidden because it is the qualifier
    -- separator of the listing display name (`alice:writing`).
    name                  TEXT        NOT NULL
                          CHECK (name ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
    -- where this definition was imported INTO: 'instance' = the operator's shared library,
    -- 'workspace' = one workspace's private library. Two rows may share a name across
    -- scopes (frozen #4 "双存"); within one scope the name is unique.
    definition_scope_type VARCHAR(16) NOT NULL,
    definition_scope_id   UUID        REFERENCES workspaces (id) ON DELETE CASCADE,
    description           TEXT        NOT NULL
                          CHECK (char_length(description) BETWEEN 1 AND 1024),
    -- SKILL.md body WITHOUT the frontmatter block (M2 injects it verbatim; keeping the
    -- frontmatter would double-count tokens and could leak metadata into the prompt).
    body                  TEXT        NOT NULL
                          CHECK (length(btrim(body)) > 0 AND octet_length(body) <= 262144),
    -- server-computed, codePointCount//2 conservative estimate (mirrors
    -- injection_budget.conservative_token_count, Python len//2 on code points).
    body_tokens_est       INTEGER     NOT NULL CHECK (body_tokens_est >= 0),
    -- D28-15: > 5000 tokens is MARKED, never rejected and never truncated.
    oversize              BOOLEAN     NOT NULL DEFAULT FALSE,
    -- D28-21: manifest only — [{path,sizeBytes,sha256,kind}], bytes stay in the source tree.
    attachments           JSONB       NOT NULL DEFAULT '[]'::jsonb
                          CHECK (jsonb_typeof(attachments) = 'array'),
    -- README frozen #5 / D28-09: trust is decided at import (the only writer); M2 only reads.
    trusted               BOOLEAN     NOT NULL DEFAULT FALSE,
    source_path           TEXT        NOT NULL
                          CHECK (length(source_path) BETWEEN 1 AND 512),
    -- sha256(name \0 description \0 body \0 canonical attachments) — server-computed only.
    content_hash          TEXT        NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
    version               INTEGER     NOT NULL DEFAULT 1 CHECK (version >= 1),
    created_by_user_id    UUID        NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT ck_skills_definition_scope
        CHECK ((definition_scope_type = 'instance'  AND definition_scope_id IS NULL)
            OR (definition_scope_type = 'workspace' AND definition_scope_id IS NOT NULL)),
    -- biconditional: also rejects "oversize=true but only 900 tokens" (the design draft's
    -- `((est > 5000) = oversize OR NOT oversize)` would have accepted it).
    CONSTRAINT ck_skills_oversize
        CHECK (oversize = (body_tokens_est > 5000)),
    -- NULLS NOT DISTINCT: the NULL `definition_scope_id` of two instance rows must collide
    -- (same trap as V87:53-55).
    CONSTRAINT uq_skills_qualified_name UNIQUE NULLS NOT DISTINCT
        (name, definition_scope_type, definition_scope_id)
);

CREATE INDEX idx_skills_definition_scope
    ON skills (definition_scope_type, definition_scope_id, name);

CREATE TABLE skill_bindings (
    id                 UUID PRIMARY KEY,
    skill_id           UUID        NOT NULL REFERENCES skills (id) ON DELETE CASCADE,
    -- 'user' | 'agent_principal' — identical vocabulary to role_bindings (V87:43,49).
    subject_type       VARCHAR(24) NOT NULL,
    subject_id         UUID        NOT NULL,
    scope_type         VARCHAR(16) NOT NULL,
    scope_id           UUID        REFERENCES workspaces (id) ON DELETE CASCADE,
    created_by_user_id UUID        NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT ck_skill_bindings_subject_type
        CHECK (subject_type IN ('user', 'agent_principal')),
    CONSTRAINT ck_skill_bindings_scope_type
        CHECK (scope_type IN ('instance', 'workspace')),
    CONSTRAINT ck_skill_bindings_scope
        CHECK ((scope_type = 'instance'  AND scope_id IS NULL)
            OR (scope_type = 'workspace' AND scope_id IS NOT NULL)),
    -- One binding per (skill, subject, scope). Without NULLS NOT DISTINCT two instance-scope
    -- bindings of the same pair could coexist (V87 round-2 P0 precedent).
    CONSTRAINT uq_skill_bindings UNIQUE NULLS NOT DISTINCT
        (skill_id, subject_type, subject_id, scope_type, scope_id)
);

-- Resolution reads by subject (user or agent) first, then narrows by scope.
CREATE INDEX idx_skill_bindings_subject ON skill_bindings (subject_type, subject_id);
CREATE INDEX idx_skill_bindings_scope   ON skill_bindings (scope_type, scope_id);
CREATE INDEX idx_skill_bindings_skill   ON skill_bindings (skill_id);
