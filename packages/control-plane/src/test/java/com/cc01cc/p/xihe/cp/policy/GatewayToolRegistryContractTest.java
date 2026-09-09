package com.cc01cc.p.xihe.cp.policy;

import com.cc01cc.p.xihe.cp.audit.AuditLogger;
import java.util.List;
import java.util.Set;
import java.util.TreeSet;
import java.util.stream.Collectors;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.Mockito.mock;

/**
 * PLAN-290 M0.2 — cross-layer tool registry contract.
 *
 * <p>The Gateway MCP tool surface (packages/runtime/src/main.rs #[tool_router]
 * fn names) is the canonical public LLM tool set. Every Gateway-public tool
 * must be classified by CP PolicyEngine as ALLOW or REQUIRE_APPROVAL;
 * unregistered tools fall through to fail-closed DENY and are contract bugs.
 *
 * <p>The Gateway set below is intentionally hardcoded (extracted from
 * #[tool] function names) rather than parsed at test time: a drift in the
 * Gateway must be an explicit edit here, visible in review — mirroring the
 * PLAN-290 §3.6-D "single source of truth + contract alignment" principle.
 * CP-only entries not yet on Gateway (apply_patch/snapshot/revert/
 * write_file_binary) are allowed as a superset; the reverse direction
 * (Gateway → Policy gap) is what this test fails on.
 */
class GatewayToolRegistryContractTest {

    /**
     * Canonical Gateway MCP tool set — extracted from
     * packages/runtime/src/main.rs #[tool_router] impl XiheRuntime
     * (rmcp exposes snake_case fn names as MCP tool names).
     * Frozen by PLAN-290 M0.2; update in lockstep with #[tool] additions.
     */
    private static final Set<String> GATEWAY_PUBLIC_TOOLS = Set.of(
        "read_file",
        "read_file_range",
        "write_file",
        "list_directory",
        "glob",
        "grep",
        "execute_command",
        "read_command_output",
        "get_file_info",
        "watch_directory",
        "edit_file",
        "delete_file",
        "delete_directory",
        "move_file",
        "copy_file",
        "mkdir",
        "extract_pdf_text",
        "web_fetch",
        "start_background_process",
        "list_background_processes",
        "get_background_process",
        "cancel_background_process"
    );

    private PolicyEngine createEngine() {
        return new PolicyEngine(mock(AuditLogger.class));
    }

    private static Set<String> classifiedUnion() {
        Set<String> union = new TreeSet<>(PolicyEngine.autoAllowTools());
        union.addAll(PolicyEngine.requireApprovalTools());
        return union;
    }

    @Test
    void gatewayTools_areNotEmpty() {
        assertEquals(22, GATEWAY_PUBLIC_TOOLS.size(),
            "Gateway tool count changed — re-extract from main.rs #[tool_router] "
                + "and update this frozen set intentionally");
    }

    @Test
    void everyGatewayTool_hasPolicyClassification() {
        Set<String> union = classifiedUnion();
        Set<String> missing = GATEWAY_PUBLIC_TOOLS.stream()
            .filter(t -> !union.contains(t))
            .collect(Collectors.toCollection(TreeSet::new));
        assertTrue(missing.isEmpty(),
            "Gateway-public tools missing from PolicyEngine "
                + "AUTO_ALLOW ∪ REQUIRE_APPROVAL (fail-closed deny): " + missing);
    }

    @Test
    void policySets_areDisjoint() {
        Set<String> intersection = new TreeSet<>(PolicyEngine.autoAllowTools());
        intersection.retainAll(PolicyEngine.requireApprovalTools());
        assertTrue(intersection.isEmpty(),
            "Tool must not be in both AUTO_ALLOW and REQUIRE_APPROVAL: " + intersection);
    }

    @Test
    void evaluate_neverDeniesGatewayPublicTool() {
        PolicyEngine engine = createEngine();
        List<String> denied = GATEWAY_PUBLIC_TOOLS.stream()
            .filter(t -> engine.evaluate(t, "{}", "contract-s1").getResult()
                == PolicyEngine.PolicyDecision.PolicyResult.DENY)
            .toList();
        assertTrue(denied.isEmpty(),
            "PolicyEngine.evaluate must not DENY Gateway-public tools: " + denied);
    }

    @Test
    void evaluate_matchesSetMembershipForEveryGatewayTool() {
        PolicyEngine engine = createEngine();
        for (String tool : GATEWAY_PUBLIC_TOOLS) {
            PolicyEngine.PolicyDecision decision = engine.evaluate(tool, "{}", "contract-s2");
            if (PolicyEngine.autoAllowTools().contains(tool)) {
                assertEquals(
                    PolicyEngine.PolicyDecision.PolicyResult.ALLOW,
                    decision.getResult(),
                    tool + " is in AUTO_ALLOW, evaluate must ALLOW");
            } else {
                assertTrue(PolicyEngine.requireApprovalTools().contains(tool),
                    tool + " must belong to REQUIRE_APPROVAL (else would DENY)");
                assertEquals(
                    PolicyEngine.PolicyDecision.PolicyResult.REQUIRE_APPROVAL,
                    decision.getResult(),
                    tool + " is in REQUIRE_APPROVAL, evaluate must REQUIRE_APPROVAL");
            }
        }
    }

    /**
     * PLAN-290 §3.6-B: web_fetch was Gateway-public but unregistered in
     * Policy → unknown deny. Minimal fix: classify as AUTO_ALLOW
     * (read-only egress fetch; runtime-side allowlist still applies).
     */
    @Test
    void webFetch_isAutoAllowed() {
        assertTrue(PolicyEngine.autoAllowTools().contains("web_fetch"),
            "web_fetch must be AUTO_ALLOW per PLAN-290 §3.6-B minimal fix");
        PolicyEngine.PolicyDecision decision =
            createEngine().evaluate("web_fetch", "{}", "contract-s3");
        assertEquals(PolicyEngine.PolicyDecision.PolicyResult.ALLOW, decision.getResult());
    }

    @Test
    void gatewayMutationTools_requireApproval() {
        Set<String> mutationOnGateway = Set.of(
            "write_file", "edit_file", "delete_file", "delete_directory",
            "move_file", "copy_file", "mkdir", "execute_command",
            "start_background_process", "cancel_background_process"
        );
        PolicyEngine engine = createEngine();
        for (String tool : mutationOnGateway) {
            assertTrue(GATEWAY_PUBLIC_TOOLS.contains(tool),
                "fixture hygiene: " + tool + " should be a Gateway tool");
            assertEquals(
                PolicyEngine.PolicyDecision.PolicyResult.REQUIRE_APPROVAL,
                engine.evaluate(tool, "{}", "contract-s4").getResult(),
                tool + " must require approval");
        }
    }

    /**
     * PLAN-292 M2 (T1/T3): container_runtime tools that stay internal-only —
     * implemented in packages/runtime/src/container_runtime.rs but NOT exposed
     * via #[tool_router]. They remain classified in PolicyEngine (require_approval)
     * so a hypothetical direct MCP call is classified, never silently allowed;
     * the Agent name list must NOT contain them (no false completeness).
     * Putting any of these on the Gateway is an explicit edit here + this set.
     */
    private static final Set<String> INTERNAL_ONLY_TOOLS = Set.of(
        "apply_patch", "create_snapshot", "revert_snapshot"
    );

    @Test
    void internalOnlyTools_areNeverGatewayPublic() {
        Set<String> leaked = new TreeSet<>(INTERNAL_ONLY_TOOLS);
        leaked.retainAll(GATEWAY_PUBLIC_TOOLS);
        assertTrue(leaked.isEmpty(),
            "internal-only tools must not appear on the Gateway: " + leaked);
    }

    @Test
    void policyClassification_isFullyAccountedFor() {
        // Every classified tool is either Gateway-public or explicitly
        // internal-only — no floating entries, no undeclared superset drift.
        Set<String> union = classifiedUnion();
        Set<String> unaccounted = new TreeSet<>(union);
        unaccounted.removeAll(GATEWAY_PUBLIC_TOOLS);
        unaccounted.removeAll(INTERNAL_ONLY_TOOLS);
        assertTrue(unaccounted.isEmpty(),
            "Policy entries must be Gateway-public or INTERNAL_ONLY: " + unaccounted);
    }

    @Test
    void internalOnlyTools_requireApproval() {
        PolicyEngine engine = createEngine();
        for (String tool : INTERNAL_ONLY_TOOLS) {
            assertEquals(
                PolicyEngine.PolicyDecision.PolicyResult.REQUIRE_APPROVAL,
                engine.evaluate(tool, "{}", "contract-s5").getResult(),
                tool + " is internal-only but must still require approval if ever called");
        }
    }
}
