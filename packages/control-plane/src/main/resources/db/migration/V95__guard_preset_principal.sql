-- PLAN-0625 M0/E (V95): the guard — a preset agent principal.
--
-- Contract sources (frozen): PLAN-0625 README §范围 (D25-01..07, Lead-approved
-- 2026-11-02). A guard is a PRESET agent principal: origin='SYSTEM_PRESET' + preset_id
-- pointing at the builtin agent-templates entry. Its cap is fixed at the input side
-- (no expandable grants + write-side refusals, commit F) — resolveCapFor stays the
-- single entry, untouched.
--
-- Two halves:
--   1. agent_principals gains origin + preset_id. Every pre-V95 principal is a
--      user-created principal: the NOT NULL DEFAULT backfills in the same statement.
--   2. The builtin guard template + role are seeded into the agent-templates config
--      domain at the instance layer — the config-domain home chosen by D25-01 (not a
--      code constant, not a frozen principal row). ON CONFLICT keeps re-migration
--      idempotent and never clobbers an admin-edited row.
--
-- Reversible: DROP the columns/constraints/index and delete the seeded config row.

-- ---------------------------------------------------------------------------
-- 1) principal origin vocabulary
-- ---------------------------------------------------------------------------

ALTER TABLE agent_principals ADD COLUMN origin TEXT NOT NULL DEFAULT 'USER';
ALTER TABLE agent_principals ADD COLUMN preset_id TEXT;

ALTER TABLE agent_principals
    ADD CONSTRAINT ck_agent_principals_origin
        CHECK (origin IN ('USER', 'SYSTEM_PRESET'));

-- A preset principal must say which preset it is; a user principal carries none.
ALTER TABLE agent_principals
    ADD CONSTRAINT ck_agent_principals_preset CHECK (
        (origin = 'SYSTEM_PRESET' AND preset_id IS NOT NULL) OR
        (origin = 'USER'));

CREATE INDEX idx_agent_principals_preset ON agent_principals (preset_id)
    WHERE preset_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 2) builtin guard template (agent-templates domain, instance layer)
--
-- The guard is an advisory member: it READS the conversation to judge, and speaks
-- like any participant (toolMode none — no workspace tools of its own; its verdict
-- reaches approvals through the policySummary input, never by holding write atoms).
-- Deterministic UUIDs (SystemAccessRoleCatalog precedent) so agents and docs can
-- reference the preset without a lookup.
-- ---------------------------------------------------------------------------

INSERT INTO config (id, layer, domain, config_key, config_value, updated_by)
VALUES (gen_random_uuid(), 'instance', 'agent-templates', 'agent-templates', '{
  "roles": [
    {
      "id": "00000000-0000-4000-8000-0000000000a1",
      "name": "guard",
      "permissions": [
        { "actionClass": "read", "resource": "*" }
      ]
    }
  ],
  "templates": [
    {
      "id": "00000000-0000-4000-8000-0000000000a2",
      "name": "守卫 Guard",
      "description": "Built-in guard preset (PLAN-0625): advisory member, read-only cap, verdicts feed the approval policy summary.",
      "systemPrompt": "You are the built-in guard of this Xihe conversation. You are an advisory member: read the conversation, speak when your policies wake you, and when asked to judge a pending action, answer with a short JSON object { \"approve\": true|false, \"reason\": \"...\" }. You hold no write capabilities; the control plane executes every approval.",
      "toolMode": "none",
      "roleId": "00000000-0000-4000-8000-0000000000a1"
    }
  ]
}'::jsonb, 'system-preset')
ON CONFLICT (domain, config_key) WHERE layer = 'instance' DO NOTHING;
