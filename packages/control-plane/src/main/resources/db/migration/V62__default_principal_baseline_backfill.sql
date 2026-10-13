-- PLAN-0416 T3.1/D1: backfill the CP-owned default Agent baseline.
--
-- The Agent no longer carries a process-level AGENT_INSTRUCTIONS fallback, and
-- instructions cross CP->Agent only from the principal's templateSnapshot
-- systemPrompt. Principals created without a template (defaultSnapshot) or
-- migrated from legacy sessions never received one, so every chat against them
-- now fails BASELINE_UNAUTHORIZED. Give them the same default text the
-- template-less creation path writes (AgentTemplateService.DEFAULT_SYSTEM_PROMPT).
--
-- Idempotent: rows that already carry a non-blank systemPrompt are untouched,
-- and a second run matches nothing.
UPDATE agent_principals
SET template_snapshot = jsonb_build_object(
        'systemPrompt',
        'You are xihe Agent. Answer in Chinese by default. Use the provided tools whenever the user asks about workspace files, directories, or commands, then answer with the tool results.')
WHERE template_snapshot IS NULL;

UPDATE agent_principals
SET template_snapshot = jsonb_set(
        template_snapshot,
        '{systemPrompt}',
        to_jsonb('You are xihe Agent. Answer in Chinese by default. Use the provided tools whenever the user asks about workspace files, directories, or commands, then answer with the tool results.'::text))
WHERE template_snapshot IS NOT NULL
  AND btrim(coalesce(template_snapshot ->> 'systemPrompt', '')) = '';
