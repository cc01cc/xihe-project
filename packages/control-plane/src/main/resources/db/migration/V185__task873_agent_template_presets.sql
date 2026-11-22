-- task-873: the agent-templates config domain speaks 「授权预设 / grant preset」.
--
-- The domain stores one config row per document key (V97 corrective): `presets` + `templates`.
-- This migration rewrites both the row key and the template's reference field, so a fresh install
-- (V95/V97 seed -> V185) and an existing database read the same vocabulary. No compatibility layer:
-- a stale `roles`/`roleId` submission is refused with 400 by AgentTemplateService.
--
-- Reversible: rename `presets` back to `roles` and `presetId` back to `roleId`.

-- 1) config row key: roles -> presets (all layers)
UPDATE config
   SET config_key = 'presets'
 WHERE domain = 'agent-templates'
   AND config_key = 'roles';

-- 2) template reference field: roleId -> presetId (all layers)
UPDATE config
   SET config_value = COALESCE((
        SELECT jsonb_agg(
                 CASE
                   WHEN element ? 'roleId'
                     THEN (element - 'roleId') || jsonb_build_object('presetId', element -> 'roleId')
                   ELSE element
                 END
                 ORDER BY ordinality)
          FROM jsonb_array_elements(config_value::jsonb) WITH ORDINALITY AS items(element, ordinality)
       ), '[]'::jsonb)
       ::text
 WHERE domain = 'agent-templates'
   AND config_key = 'templates'
   AND jsonb_typeof(config_value::jsonb) = 'array';

-- 3) legacy whole-document rows (the V95 shape V97 deleted): convert in place if one survived
--    in another layer. The service refuses the retired key anyway; this keeps the stored JSON
--    self-consistent for inspection.
UPDATE config
   SET config_value = ((config_value::jsonb - 'roles')
        || jsonb_build_object('presets', config_value::jsonb -> 'roles'))::text
 WHERE domain = 'agent-templates'
   AND config_key = 'agent-templates'
   AND config_value::jsonb ? 'roles';

UPDATE config
   SET config_value = jsonb_set(config_value::jsonb, '{templates}', COALESCE((
        SELECT jsonb_agg(
                 CASE
                   WHEN element ? 'roleId'
                     THEN (element - 'roleId') || jsonb_build_object('presetId', element -> 'roleId')
                   ELSE element
                 END
                 ORDER BY ordinality)
          FROM jsonb_array_elements(config_value::jsonb -> 'templates') WITH ORDINALITY AS items(element, ordinality)
       ), '[]'::jsonb))::text
 WHERE domain = 'agent-templates'
   AND config_key = 'agent-templates'
   AND jsonb_typeof(config_value::jsonb -> 'templates') = 'array';
