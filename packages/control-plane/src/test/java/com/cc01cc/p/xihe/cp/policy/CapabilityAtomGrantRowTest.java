package com.cc01cc.p.xihe.cp.policy;

import com.cc01cc.p.xihe.cp.entity.AuthorizationGrant;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Set;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * task-895: a capability-family atom in a <b>stored</b> {@code grants.permissions} row is inert.
 *
 * <p>The defect this pins: {@link GrantIntersectionEvaluator.PermissionAtom}'s constructor treats
 * every non-action name as {@code Unknown actionClass} and throws. Because a grant row is persisted
 * data written by several paths (the materializer, raw-SQL fixtures, legacy backfills), one
 * {@code cap:...} row turned <b>every</b> evaluation of that subject into a 500 — including the
 * {@code MANAGE_ROLES} gate on {@code GET /api/v1/presets}.</p>
 *
 * <p>The three cases below are the card's required readings, at the kernel level:</p>
 * <ol>
 *   <li>a cap-only row is skipped, not thrown on;</li>
 *   <li>the ALLOW/DENY verdicts are <b>identical</b> with and without the cap row — the cap never
 *       participates in the action judgement (reverse proof);</li>
 *   <li>the filter is scoped to the <b>stored-row</b> entry point: a caller-supplied atom array is
 *       still validated strictly, so a typo cannot be silently dropped.</li>
 * </ol>
 */
class CapabilityAtomGrantRowTest {

    private final ObjectMapper mapper = new ObjectMapper();
    private final GrantIntersectionEvaluator evaluator = new GrantIntersectionEvaluator();

    @Test
    void storedCapabilityAtomIsSkippedInsteadOfFailingTheWholeRead() throws Exception {
        AuthorizationGrant capOnly = grant("[{\"actionClass\":\"cap:workspace:admin\"}]");
        AuthorizationGrant unregisteredCap = grant("[{\"actionClass\":\"cap:not:registered\"}]");

        assertEquals(Set.of(), evaluator.union(List.of(capOnly)));
        assertEquals(List.of(), evaluator.unionAttributed(List.of(capOnly)));
        assertEquals(Set.of(), evaluator.union(List.of(unregisteredCap)),
                "an unregistered cap:* value is inert too -- it must never be read as an action class");
    }

    @Test
    void capabilityRowNeitherGrantsNorWidensAnAction() throws Exception {
        AuthorizationGrant readRow = grant("[{\"actionClass\":\"action:read\"}]");
        AuthorizationGrant capRow = grant("[{\"actionClass\":\"cap:workspace:admin\"}]");

        Set<GrantIntersectionEvaluator.PermissionAtom> withoutCap =
                evaluator.union(List.of(readRow));
        Set<GrantIntersectionEvaluator.PermissionAtom> withCap =
                evaluator.union(List.of(readRow, capRow));
        assertEquals(withoutCap, withCap,
                "the cap row must not change the effective atom set");

        PolicyRequest read = request("read");
        PolicyRequest write = request("write");
        assertTrue(evaluator.allows(read, List.of(withoutCap)));
        assertTrue(evaluator.allows(read, List.of(withCap)),
                "ALLOW is unchanged (the read action was and stays held)");
        assertFalse(evaluator.allows(write, List.of(withoutCap)));
        assertFalse(evaluator.allows(write, List.of(withCap)),
                "DENY is unchanged -- a cap row must never widen the action judgement");
    }

    @Test
    void callerSuppliedAtomArraysStayStrict() throws Exception {
        assertThrows(IllegalArgumentException.class, () -> evaluator.parse(
                        mapper.readTree("[{\"actionClass\":\"cap:workspace:admin\"}]")),
                "the skip is a stored-row rule; a request that sends a capability atom still fails closed");
    }

    private AuthorizationGrant grant(String permissionsJson) throws Exception {
        AuthorizationGrant grant = new AuthorizationGrant();
        grant.setId(UUID.randomUUID());
        grant.setSource(GrantSources.PRESET);
        grant.setPermissions(mapper.readTree(permissionsJson));
        return grant;
    }

    private static PolicyRequest request(String actionClass) {
        return new PolicyRequest("task-895", List.of(actionClass), List.of("*"), ToolShape.OPAQUE,
                null, null, null);
    }
}
