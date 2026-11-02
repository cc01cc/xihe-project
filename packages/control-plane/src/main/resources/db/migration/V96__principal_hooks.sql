-- PLAN-0625 F (V96): the hook subscriptions of an agent principal.
--
-- D25-08..11 + Lead rulings (2026-11-02): hooks graduated from a guard feature to a
-- CAPABILITY SURFACE of a principal. The template (agent-templates config domain) is the
-- DECLARATION source; the principal row is the RUNTIME single-read surface (N10 — the gate
-- never reads the template). Preset guards get their subscriptions copied here at
-- instantiation; user-defined principals carry theirs only here (they have no template —
-- that asymmetry is why the single-read surface must live on the row).
--
-- Key contract DRAFT (the implementation task finalizes it): hooks = {"advisors":
-- [{"kind": "<open string — no registry, D25-10>", ...config}], "on": ["approval.ask"]}.
-- "kind" is deliberately NOT an enum: the seam stays open without a plugin framework (YAGNI).
--
-- Reversible: DROP COLUMN hooks. No backfill — NULL means "no subscriptions".

ALTER TABLE agent_principals ADD COLUMN hooks JSONB;