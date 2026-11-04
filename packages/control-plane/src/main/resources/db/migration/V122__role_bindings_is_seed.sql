-- PLAN-0667 follow-up (Lead ruling 2026-11-05): separate "seed binding" from "system role".
--
-- Why this migration exists
--   `ROLE_BINDING_IMMUTABLE` used to be derived from `roles.is_system`, which conflated two very
--   different things:
--     (a) a **seed/default binding** — written by migrations or by the principal-creation defaults,
--         representing "granted by default", which must not be deleted;
--     (b) a binding the **user created** for a role that happens to be a system role
--         (WS_EDITOR/WS_VIEWER/AGENT_DELEGATOR/AGENT_SPAWNER), which the user must be able to undo.
--   Consequence before this fix: binding the most useful roles to an agent principal was a one-way
--   door (DELETE answered 409 forever) — a data-reversibility defect, not a UX nicety.
--
-- What changes
--   The immutable bit moves onto the binding row. `is_seed=true` is written only by the
--   default-granting paths (migrations / creation-time default role); every binding created through
--   the public binding API keeps the DEFAULT FALSE and is deletable, regardless of
--   `roles.is_system`.
--
-- Backfill
--   Rows that exist before this migration predate the PLAN-0667 binding API, so they are exactly the
--   seeded defaults (V88 user tiers, V108 agent workspace backfill, creation-time defaults). Mark
--   them `is_seed = TRUE` to preserve their current immutable behaviour (Lead: regression must not
--   break). Fresh deployments run this with an empty `role_bindings` table; code paths then set the
--   flag explicitly (AgentPrincipalService default grants) or leave it false (API bindings).
ALTER TABLE role_bindings
    ADD COLUMN is_seed BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN role_bindings.is_seed IS
    'PLAN-0667: true = seed/default binding (immutable via ROLE_BINDING_IMMUTABLE); false = created through the binding API (deletable, even when the role is a system role).';

UPDATE role_bindings
SET is_seed = TRUE
WHERE subject_type = 'agent_principal';
