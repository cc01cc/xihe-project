-- PLAN-0625 task-91 (Gap E): V97 corrective for the V95 builtin guard seed.
--
-- Root cause (walkthrough-verified): the V95 seed used config_key = 'agent-templates' (the
-- DOMAIN name) with a full document {roles, templates} as the value. Domain documents
-- assemble from INNER keys (ConfigServiceTest precedent: config_key = 'templates',
-- value = array), so the assembled agent-templates doc carried a spurious top-level
-- 'agent-templates' key and the schema (additionalProperties: false) rejected EVERY read
-- with 409 AGENT_TEMPLATE_CONFIG_INVALID — the builtin template was unreadable.
--
-- Corrective (D16 order: remove the mis-keyed row, then seed the two inner-keyed rows):
--   1. DELETE the mis-keyed row. It is wrong under the assembly convention regardless of
--      any admin edits on top of it.
--   2. INSERT 'roles' + 'templates' rows with ON CONFLICT DO NOTHING — re-migration safe
--      and never clobbers admin-authored rows.
--
-- Reversible: delete the two seeded rows; the mis-keyed row is gone by design (it was the bug).

-- 1) remove the mis-keyed V95 seed
DELETE FROM config
 WHERE layer = 'instance' AND domain = 'agent-templates' AND config_key = 'agent-templates';

-- 2) seed the inner-keyed rows (the assembly convention: one row per document key)
INSERT INTO config (id, layer, domain, config_key, config_value, updated_by)
VALUES (gen_random_uuid(), 'instance', 'agent-templates', 'roles', '[
  {
    "id": "00000000-0000-4000-8000-0000000000a1",
    "name": "guard",
    "permissions": [
      { "actionClass": "read", "resource": "*" }
    ]
  }
]'::jsonb, 'system-preset')
ON CONFLICT (domain, config_key) WHERE layer = 'instance' DO NOTHING;

INSERT INTO config (id, layer, domain, config_key, config_value, updated_by)
VALUES (gen_random_uuid(), 'instance', 'agent-templates', 'templates', '[
  {
    "id": "00000000-0000-4000-8000-0000000000a2",
    "name": "守卫 Guard",
    "description": "Built-in guard preset (PLAN-0625): advisory member, read-only cap, verdicts feed the approval policy summary.",
    "systemPrompt": "You are the built-in guard of this Xihe conversation. You are an advisory member: read the conversation, speak when your policies wake you, and when asked to judge a pending action, answer with a short JSON object { \"approve\": true|false, \"reason\": \"...\" }. You hold no write capabilities; the control plane executes every approval.",
    "toolMode": "none",
    "roleId": "00000000-0000-4000-8000-0000000000a1"
  }
]'::jsonb, 'system-preset')
ON CONFLICT (domain, config_key) WHERE layer = 'instance' DO NOTHING;
