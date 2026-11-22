package com.cc01cc.p.xihe.cp.policy.mcpresource;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.cc01cc.p.xihe.cp.policy.GrantIntersectionEvaluator;
import com.cc01cc.p.xihe.cp.policy.PolicyRequest;
import com.cc01cc.p.xihe.cp.policy.ResourceIdentity;
import com.cc01cc.p.xihe.cp.policy.ToolShape;
import java.util.List;
import java.util.Set;
import org.junit.jupiter.api.Test;

/**
 * task-870 / D-1921 acceptance kernel: {@code mcp:<sid>} is appended to the object resources, so
 * the intersection requires both pairs. These are the positive / key counterexample / control
 * readings; {@link McpGatewayResourceAppendTest} proves the gateway actually appends the value.
 */
class McpGrantIntersectionTest {

    private static final String WS = "11111111-1111-4111-8111-111111111111";
    private static final String OBJECT = "fs:" + WS + "/src/a.txt";
    private static final String SERVER = "mcp:github";

    private final GrantIntersectionEvaluator evaluator = new GrantIntersectionEvaluator();

    {
        // `fs:` vs `fs:` is compared by physical identity, never by string equality; a resolver is
        // required even in a pure unit test (fail-closed otherwise).
        evaluator.useScopeResolver(id -> new ResourceIdentity.RootScope(
                ResourceIdentity.ScopeKind.WORKSPACE, "/ws"));
    }

    @Test
    void holdsBothObjectAndServerPairIsAllowed() {
        assertTrue(allows(false, write(OBJECT), write(SERVER)));
    }

    @Test
    void onlyTheServerPairIsRefused() {
        // The key counterexample: if the implementation replaced the object resource with mcp:,
        // this would pass (a widening). It must fail.
        assertFalse(allows(false, write(SERVER), write("mcp:*")));
    }

    @Test
    void onlyTheObjectPairIsRefusedWhenTheServerPairIsRequired() {
        assertFalse(allows(false, write(OBJECT)));
    }

    @Test
    void controlWithoutTheServerResourceIsAllowed() {
        // Proves the denial above is caused by this pair and not by an unrelated gate.
        assertTrue(allows(true, write(OBJECT)));
    }

    @Test
    void aBareWildcardDoesNotCoverTheServerPair() {
        // Every preset (including every agent preset) holds `write@*`; that must not open the gate.
        assertFalse(allows(false, write(OBJECT), wildcardWrite()));
    }

    private boolean allows(boolean withServer, GrantIntersectionEvaluator.PermissionAtom... atoms) {
        List<String> resources = withServer ? List.of(OBJECT) : List.of(OBJECT, SERVER);
        PolicyRequest request = new PolicyRequest("write_file", List.of("write"), resources,
                ToolShape.STRUCTURED, "user", WS, "session");
        return evaluator.allows(request, List.of(Set.of(atoms)));
    }

    private static GrantIntersectionEvaluator.PermissionAtom write(String resource) {
        return new GrantIntersectionEvaluator.PermissionAtom("write", resource);
    }

    private static GrantIntersectionEvaluator.PermissionAtom wildcardWrite() {
        return write("*");
    }
}
