package com.cc01cc.p.xihe.cp.policy;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.junit.jupiter.api.Test;

/**
 * task-835 (approval contract §2.3): approval authority is the atom
 * {@code (action:approve, the resource of this request)} — not a hard-coded run-owner branch.
 *
 * <p>Three invariants are pinned here: the atom carries the request-scoped sentinel instead of
 * {@code *}; only SUPER_ADMIN (mirror) / ADMIN / WS_OWNER receive it by default; and the sentinel
 * matches exactly the request's own resource for the approve action — never a wildcard request and
 * never another atom.</p>
 */
class ApproveAtomContractTest {

    private static final String APPROVE = "action:approve";
    private static final String WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";

    @Test
    void approveIsAnOrdinaryActionAtomWithARequestScopedResource() {
        PermissionAtomCatalog.Atom atom = PermissionAtomCatalog.atom("approve");
        assertEquals(APPROVE, atom.name());
        assertFalse(atom.capability(), "approve is an action atom, not a capability");
        assertEquals(PermissionAtomCatalog.SCOPE_CLASS_BOTH, atom.scopeClass());
        assertEquals(ResourceNamespaces.REQUEST_RESOURCE, atom.canonicalResource());
        assertNotEquals(PermissionAtomCatalog.WILDCARD, atom.canonicalResource(),
                "a wildcard canonical resource would turn one approval into a blanket one");
        assertTrue(PermissionAtomCatalog.isActionAtom(APPROVE));
        assertEquals(atom, PermissionAtomCatalog.atom(APPROVE), "bare and canonical resolve alike");
    }

    @Test
    void onlySuperAdminAdminAndWorkspaceOwnerCarryTheDefaultApproveGrant() {
        Map<String, Set<String>> seeds = new LinkedHashMap<>();
        for (SystemGrantPresetCatalog.PresetSeed seed : SystemGrantPresetCatalog.presetSeeds()) {
            Set<String> atoms = new LinkedHashSet<>();
            seed.atoms().forEach(ref -> atoms.add(ref.actionClass() + "|" + ref.resourcePattern()));
            seeds.put(seed.name(), atoms);
        }
        String expected = APPROVE + "|" + ResourceNamespaces.REQUEST_RESOURCE;
        for (String granted : List.of(SystemGrantPresetCatalog.SUPER_ADMIN,
                SystemGrantPresetCatalog.ADMIN, SystemGrantPresetCatalog.WS_OWNER)) {
            assertTrue(seeds.get(granted).contains(expected),
                    granted + " must carry the default approve grant " + expected);
        }
        for (String other : List.of(SystemGrantPresetCatalog.USER, SystemGrantPresetCatalog.WS_EDITOR,
                SystemGrantPresetCatalog.WS_VIEWER, SystemGrantPresetCatalog.AGENT_DELEGATOR,
                SystemGrantPresetCatalog.AGENT_USER, SystemGrantPresetCatalog.AGENT_READER,
                SystemGrantPresetCatalog.AGENT_WORKER, SystemGrantPresetCatalog.WS_RUNNER,
                SystemGrantPresetCatalog.ORG_LEADER)) {
            assertFalse(seeds.get(other).contains(expected),
                    other + " must NOT carry approve by default (least privilege)");
        }
    }

    @Test
    void theSentinelCoversTheRequestsOwnResourceForApproveOnly() {
        GrantIntersectionEvaluator evaluator = new GrantIntersectionEvaluator();
        Set<GrantIntersectionEvaluator.PermissionAtom> level = Set.of(
                new GrantIntersectionEvaluator.PermissionAtom(APPROVE,
                        ResourceNamespaces.REQUEST_RESOURCE));
        PolicyRequest request = new PolicyRequest("approve", List.of(APPROVE),
                List.of("fs:" + WORKSPACE_ID + "/runs/42"),
                ToolShape.STRUCTURED, "user", "ws", "session");
        assertTrue(evaluator.allows(request, List.of(level)),
                "the request's own resource is covered by the approve sentinel");

        PolicyRequest wildcardRequest = new PolicyRequest("approve", List.of(APPROVE),
                List.of("*"), ToolShape.STRUCTURED, "user", "ws", "session");
        assertFalse(evaluator.allows(wildcardRequest, List.of(level)),
                "a wildcard approve request names no object and must fail closed");

        Set<GrantIntersectionEvaluator.PermissionAtom> readLevel = Set.of(
                new GrantIntersectionEvaluator.PermissionAtom("action:read",
                        ResourceNamespaces.REQUEST_RESOURCE));
        PolicyRequest read = new PolicyRequest("read", List.of("action:read"),
                List.of("fs:" + WORKSPACE_ID + "/runs/42"),
                ToolShape.STRUCTURED, "user", "ws", "session");
        assertFalse(evaluator.allows(read, List.of(readLevel)),
                "the sentinel must never widen a non-approve atom");
    }
}
