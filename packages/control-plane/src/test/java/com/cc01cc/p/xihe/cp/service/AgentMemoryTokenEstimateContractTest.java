package com.cc01cc.p.xihe.cp.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0629 M1-4 cross-language pin: the memory token estimate must be the <b>same rule</b> in CP and
 * in the Agent runtime.
 *
 * <p>CP uses the estimate to decide how many memory entries fit into a component's {@code maxTokens};
 * the Agent's {@code context/injection_budget.py} uses the same number to charge the run ledger. If the
 * two drift, CP hands over more text than the ledger can pay for — the Agent would then have to drop
 * text CP already promised, which is exactly the failure mode the design forbids.</p>
 *
 * <p>So the rule is pinned by a <b>shared fixture</b>, not by a comment:
 * {@code spec/fixtures/memory-token-estimate.json} is read by this test <b>and</b> by
 * {@code packages/agent/tests/contracts/test_memory_token_estimate_contract.py}. Adding a case to the
 * fixture makes both suites assert it.</p>
 */
class AgentMemoryTokenEstimateContractTest {

    /** Maven runs with the module as working directory (packages/control-plane). */
    private static final Path FIXTURE = Path.of("..", "..", "spec", "fixtures",
            "memory-token-estimate.json");

    @Test
    void cpAndAgentUseTheSameEstimateRule() throws IOException {
        assertTrue(Files.isRegularFile(FIXTURE), "shared fixture is missing: " + FIXTURE.toAbsolutePath());
        JsonNode root = new ObjectMapper().readTree(Files.readString(FIXTURE));
        JsonNode cases = root.path("cases");
        assertNotNull(cases, "fixture must carry a cases array");
        assertTrue(cases.isArray() && !cases.isEmpty(), "fixture needs at least one case");

        for (JsonNode item : cases) {
            String input = item.path("input").asText();
            int expected = item.path("tokens").asInt();
            assertTrue(expected == AgentMemoryInjectionService.estimateTokens(input),
                    "estimate drift for input of length " + input.length() + ": CP says "
                            + AgentMemoryInjectionService.estimateTokens(input) + ", contract says "
                            + expected);
        }
    }
}
