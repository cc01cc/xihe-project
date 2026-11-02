-- PLAN-0625 task-92 (D25-09): seed the hook subscriptions on the builtin guard template.
--
-- Root cause (walkthrough-verified): V97 seeded the guard template WITHOUT a `hooks` field, so every
-- principal created from it subscribes to nothing — the D25-09 ruling ("预置守卫 = 模板里预配好
-- hook 订阅，数据不是机制差异") is unfulfilled and the guard-advice chain is a dead end for
-- preset guards.
--
-- Corrective: extend the V97-seeded `templates` instance row in place. The template document shape
-- (id/name/description/systemPrompt/toolMode/roleId) gains
--   hooks = { advisors: [ { kind: "guard", on: ["approval.ask"] } ] }
-- where `kind` must match GuardHookAdvisor.KIND and `on` values must hit
-- HookAdvisorRegistry.ALLOWED_ACTION_CLASSES (today: approval.ask) — otherwise the create/update
-- write gate (HookAdvisorRegistry.validateSubscriptions) would reject the created principal 400.
--
-- Shape notes:
--   * `config_value` is TEXT in this schema (V97 casts the literal to jsonb on the way in), so the
--     update casts to jsonb, edits, and casts back to text;
--   * only the entry whose id is the builtin guard template (…a2) is touched — an admin-authored
--     templates array keeps every other entry byte-identical;
--   * the guard fires on approval creation only (its own idempotent projection of D25-04/15).
--
-- Reversible: jsonb_set the guard entry's hooks back to NULL (jsonb_set(..., '{0,hooks}', 'null')).

UPDATE config
   SET config_value = jsonb_set(
         config_value::jsonb,
         '{0,hooks}',
         '{
            "advisors": [
              { "kind": "guard", "on": ["approval.ask"] }
            ]
          }'::jsonb,
         true)::text
 WHERE layer = 'instance'
   AND domain = 'agent-templates'
   AND config_key = 'templates'
   AND EXISTS (
         SELECT 1
           FROM jsonb_array_elements(config_value::jsonb) AS t
          WHERE t->>'id' = '00000000-0000-4000-8000-0000000000a2');
