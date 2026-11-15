-- task-173 (user ruling 40C / D-1532 §5; Lead ruling D-1540): a REAL ownership column on
-- agent_principals. Before this migration the table could not answer "instance-owned platform agent
-- or a user's own agent": both creation doors (/api/v1/agent-principals and
-- /api/v1/instance/agent-principals) write origin='USER' and owner_user_id IS NULL (V90's owner
-- column stayed; V126 kept it), so the two kinds of row are physically identical. The discriminator
-- used to be the request path ("40A"), which no read face can filter and no write guard can check.
--
-- Two states, not three (D-1540 §2):
--   USER      the user/workspace door created it; its creator (and, later, a binding workspace) manage it.
--   INSTANCE  the instance door created it (the deployment's platform agent); only the
--             MANAGE_AGENT_PRINCIPALS atom manages it, evaluated at the atom layer (never a role name).
-- No third 'SYSTEM' state: origin='SYSTEM_PRESET' (the builtin guard preset, V95) already marks the
-- system asset on its own axis, and ownership=INSTANCE is the same fact stated once — the second
-- CHECK below keeps the two axes from ever contradicting each other.
-- No 'UNKNOWN' state either: 'ownership cannot be determined' is a decision made at migration time,
-- never a value that may live in the column (D-1533: a row nobody can attribute would be a legal
-- long-term state, which is exactly the fail-open we are removing).
--
-- No DEFAULT on purpose (D-1540 §1): DEFAULT 'USER' would let a forgotten write in the instance door
-- land as a user row (privilege escalation, fail-open); DEFAULT 'INSTANCE' would make a forgotten
-- write in the user door lock the creator out of their own agent. NOT NULL without a default turns a
-- forgotten write into a hard error instead of a silent mislabel.
--
-- Backfill: none is possible for the legacy user rows. The ONLY determinable class is the builtin
-- preset (origin='SYSTEM_PRESET'), which is platform-owned by definition. Every other legacy row is
-- genuinely ambiguous, so this migration REFUSES to guess: it raises with the row count and the
-- cleanup command. D-1533 (user ruling) authorizes dropping old data instead of being compatible with
-- it; DEV-002 §8.3 says the same for dev databases. Upgrade a database with old data as: clean first,
-- then migrate.
--
-- Reversible: DROP the two constraints, the index and the column.
--
-- Number: V170 was free on develop (max V169) and in the only checkout on this machine when this was
-- written. Re-run the three checks (main / other worktrees / flyway_schema_history) at merge time and
-- rename if a lane took V170 meanwhile.

ALTER TABLE agent_principals ADD COLUMN ownership VARCHAR(16);

-- The single determinable legacy class: a builtin preset principal is an instance asset.
UPDATE agent_principals SET ownership = 'INSTANCE' WHERE origin = 'SYSTEM_PRESET';

DO $$
DECLARE
    unresolved INTEGER;
BEGIN
    SELECT count(*) INTO unresolved FROM agent_principals WHERE ownership IS NULL;
    IF unresolved > 0 THEN
        RAISE EXCEPTION 'V170 cannot determine ownership for % legacy AI principal row(s): both creation doors wrote origin=''USER'' with owner_user_id NULL, so instance-created and user-created rows are physically identical and any default would be a lie (D-1533 forbids guessing). Clean first, then migrate: (a) dev/discardable database -> mise run dev:reset --apply, then start the services again so Flyway replays the whole chain; (b) keep the database -> delete the unresolvable principals in FK order: role_bindings, skill_bindings, grants (subject_type=agent_principal and role rows), workspace_agents, session_participants, sessions.agent_principal_id -> NULL, scheduled_tasks.agent_principal_id -> NULL, agent_memories (ON DELETE CASCADE), then DELETE FROM agent_principals; then restart so V170 replays. Both routes are documented in DEV-002 §首跑建号 (8.3 for the data rule).', unresolved;
    END IF;
END
$$;

ALTER TABLE agent_principals ALTER COLUMN ownership SET NOT NULL;

-- 1) the value domain. 2) the cross-axis invariant: a preset principal is instance-owned, always.
ALTER TABLE agent_principals
    ADD CONSTRAINT ck_agent_principals_ownership
        CHECK (ownership IN ('USER', 'INSTANCE'));
ALTER TABLE agent_principals
    ADD CONSTRAINT ck_agent_principals_ownership_preset
        CHECK (origin <> 'SYSTEM_PRESET' OR ownership = 'INSTANCE');

-- The instance read face filters on ownership='INSTANCE'; a partial index keeps it proportional to
-- the platform agents actually installed rather than to every user-created row.
CREATE INDEX idx_agent_principals_ownership_instance
    ON agent_principals (created_at DESC)
    WHERE ownership = 'INSTANCE';
