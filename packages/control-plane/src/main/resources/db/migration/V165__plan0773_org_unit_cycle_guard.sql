-- V165 (PLAN-0773 / M1-3): refuse a parent change that would close a cycle in org_units.
--
-- Why a trigger and not "the service will check": design.md:69 puts the ring guard here, on
-- purpose. A cycle is not a per-endpoint mistake -- it is a tree that can no longer be walked, so
-- every later query (path <@, ancestor chains in the governance judge) either loops or silently
-- mis-answers. A check in one writer is a check in EVERY writer that will ever exist; the
-- database is the only place where "every writer" is true by construction.
--
-- Why the ancestor walk instead of comparing NEW.parent_id with OLD.id:
--   the one-level comparison catches self-parenting and the A<->B pair, and nothing else. It
--   passes exactly the tests that are easy to write. The failing shape is the deep one: with
--   A->B->C->D, making D the parent of A closes the ring through four rows, and a one-level
--   check sees nothing wrong (A != D). So the trigger walks from NEW.parent_id up to the root
--   and refuses if it meets NEW.id anywhere on that chain.
--   The walk uses a recursive CTE with UNION (not UNION ALL): if the table somehow already
--   contained a cycle, UNION de-duplicates and the query terminates instead of running until
--   the connection dies. A guard loop with a magic iteration cap would need a second exception
--   code for "the data was already broken", which is a worse story to tell a caller.
--
-- Why BEFORE and why "UPDATE OF parent_id":
--   BEFORE => the row is refused, not written and then rolled back by the caller; the caller
--   gets the error at the statement that caused it. "UPDATE OF parent_id" => a rename or a
--   timestamp bump does not take the lock or walk the chain at all.
--
-- Why the advisory lock (design.md:69): two concurrent moves can each be individually legal and
-- together close a ring (A moves under B while B moves under A -- each sees the pre-state). The
--   transaction-scoped lock serialises parent changes so the second one sees the first. It is
--   taken only when a real parent change is being checked: moving a unit to the root (parent_id
--   NULL) cannot create a cycle and returns before the lock, so root moves stay concurrent.
--
-- Why a custom SQLSTATE: the caller has to branch on "this was a cycle" and offer a different
-- sentence than for a constraint violation. Branching on a message text is unfalsifiable --
-- message wording changes, translations exist, and the text is not part of any contract. The
-- code is: XH001 (class XH is not assigned by PostgreSQL or the SQL standard, so it cannot
-- collide with 23xxx integrity errors). The message names BOTH the moved unit and the intended
-- parent, because "cycle detected" tells a support engineer nothing about which two units to
-- look at.
--
-- Out of scope on purpose: the subtree move itself (M1-4) and org_unit_role_bindings (M1-9).
-- This migration only makes the illegal move impossible; it does not perform the legal one.
--
-- Number allocation taken with the gate (task-164 / task-176):
--   before writing : node scripts/check-migration-numbers.mjs => files=156 max=V164 next=V165
--   after writing, before registering => E_REGISTRY_STALE + E_MIGRATION_NOT_REGISTERED
--   base sha at write time = b503e1d31 (2026-11-13)

CREATE FUNCTION org_units_reject_cycle() RETURNS trigger AS $$
DECLARE
    offending_ancestor UUID;
BEGIN
    IF NEW.parent_id IS NULL THEN
        -- Moving to the root cannot close a ring, and it is the one move that does not need
        -- serialising against other moves.
        RETURN NEW;
    END IF;

    PERFORM pg_advisory_xact_lock(hashtext('org_units'));

    WITH RECURSIVE ancestors AS (
        SELECT u.id, u.parent_id FROM org_units u WHERE u.id = NEW.parent_id
        UNION
        SELECT u.id, u.parent_id FROM org_units u JOIN ancestors a ON u.id = a.parent_id
    )
    SELECT a.id INTO offending_ancestor FROM ancestors a WHERE a.id = NEW.id LIMIT 1;

    IF offending_ancestor IS NOT NULL THEN
        RAISE EXCEPTION
            USING ERRCODE = 'XH001',
                  MESSAGE = format(
                      'org unit cycle refused: %s cannot become a child of %s',
                      NEW.id, NEW.parent_id),
                  DETAIL = format(
                      '%s is %s or one of its ancestors, so this move would close a ring',
                      NEW.id, NEW.parent_id),
                  HINT = format(
                      'pick a parent that is not %s and not below it', NEW.id);
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_org_units_reject_cycle
    BEFORE UPDATE OF parent_id ON org_units
    FOR EACH ROW
    EXECUTE FUNCTION org_units_reject_cycle();
