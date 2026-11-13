-- V164 (PLAN-0773 / M1-2): org_unit_members — who belongs to which unit.
--
-- Shape comes from design.md 3.2 (lines 80-88), not from taste. Two things in it are load-
-- bearing in a way that a "reasonable" rewrite would quietly destroy:
--
--   1. PRIMARY KEY (member_kind, member_id) IS the judgement, not a formality.
--      design.md:90: one human / one agent belongs to exactly ONE unit. Expressed as a primary
--      key, "try to hang the same member on a second unit" is a 23505 at insert time, in every
--      writer, forever. Expressed as (id BIGSERIAL PRIMARY KEY + UNIQUE (member_kind,
--      member_id)), it is the same guarantee only as long as nobody adds a second writer path
--      that forgets to check -- i.e. it becomes an application-level habit. The surrogate-id
--      form is therefore NOT an equivalent implementation and must not be substituted.
--      Consequence worth knowing: members are keyed by identity, so a member row has no
--      independent id to address by; the writer addresses (member_kind, member_id).
--
--   2. member_kind is a closed vocabulary, checked in the database.
--      IN (human, agent_principal) is case- and plural-sensitive on purpose: users / Human /
--      AGENT_PRINCIPAL are rejected rather than silently accepted, because a stray spelling
--      would create a member that no query looks for ("the agent exists but belongs nowhere").
--      VARCHAR(16) bounds the column; the CHECK bounds the meaning.
--
-- Deletion behaviour: org_unit_id REFERENCES org_units(id) ON DELETE RESTRICT, which is what
-- design.md:81 says. Checked rather than copied: M1-1 (V163) used RESTRICT for the parent link
-- too, so the two agree -- but they agree because both were read, not because one was imitated.
-- A unit with members cannot be deleted; removing members is an explicit act (M1-4 / API layer).
--
-- No polymorphic foreign key: member_id points at users or agent_principals depending on
-- member_kind, and PostgreSQL cannot express that as one FK. design.md:91 rules the cross-table
-- check to the service layer + a periodic consistency script, explicitly NOT to triggers (a
-- cross-table trigger would take locks in an order the subtree move can deadlock against).
-- This migration therefore creates no trigger -- and that is a DECISION, not an omission.
--
-- Out of scope on purpose: no trigger (M1-3), no subtree move (M1-4), no
-- org_unit_role_bindings (M1-9), no seed rows (M1-6) -- this file is shape only.
--
-- Column set is exactly the four in design.md:80-85 (org_unit_id, member_kind, member_id,
-- created_at). No updated_at: membership is created and deleted, never edited, so a column that
-- would always equal created_at is a column nobody can keep honest.
--
-- Number allocation taken with the gate (task-164 / task-175):
--   before writing : node scripts/check-migration-numbers.mjs => files=155 max=V163 next=V164
--   after writing, before registering => E_REGISTRY_STALE + E_MIGRATION_NOT_REGISTERED
--   base sha at write time = e2fc62fb4 (2026-11-13)

CREATE TABLE org_unit_members (
    org_unit_id UUID NOT NULL REFERENCES org_units (id) ON DELETE RESTRICT,
    member_kind VARCHAR(16) NOT NULL CHECK (member_kind IN ('human', 'agent_principal')),
    member_id   UUID NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- design.md:85/90 -- see header reason 1 before changing this line.
    PRIMARY KEY (member_kind, member_id)
);

-- design.md:87: the hot query is "who is in this unit" (and the FK check on unit deletion),
-- which walks org_unit_id. The PK already indexes (member_kind, member_id) -- the other
-- direction -- so without this index a unit listing is a sequential scan.
CREATE INDEX idx_org_unit_members_unit ON org_unit_members (org_unit_id);
