package com.cc01cc.p.xihe.cp.support;

import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0633 C1-4: the runtime gate's own contract. The combination fingerprint must catch the real
 * leak and must not fire on legitimate documents that merely carry a {@code nodeType} key.
 */
class Jackson2NodeWireTest {

    /** The walked-through shape from PLAN-0625 Gap J (a1219a21). */
    private static final String LEAKED = "{\"principalId\":\"p1\",\"hooks\":{\"array\":false,"
            + "\"nodeType\":\"OBJECT\",\"containerNode\":false,\"missingNode\":false}}";

    private static final String HEALTHY_HOOKS = "{\"principalId\":\"p1\","
            + "\"hooks\":{\"advisors\":[{\"kind\":\"guard\",\"on\":[\"approval.requested\"]}]}}";

    private static final String BUSINESS_NODE_TYPE = "{\"nodeType\":\"worker\",\"name\":\"alpha\"}";

    @Test
    void detectsTheJackson2BeanFingerprint() {
        List<Jackson2NodeWire.Leak> leaks = Jackson2NodeWire.scan(LEAKED);

        assertEquals(1, leaks.size(), "expected exactly one leak, got: " + leaks);
        assertEquals("$.hooks", leaks.get(0).path());
    }

    @Test
    void acceptsADocumentThatMerelyCarriesANodeTypeKey() {
        assertEquals(List.of(), Jackson2NodeWire.scan(HEALTHY_HOOKS));
        assertEquals(List.of(), Jackson2NodeWire.scan(BUSINESS_NODE_TYPE));
    }

    @Test
    void nonJsonAndEmptyBodiesAreNotAssertions() {
        assertEquals(List.of(), Jackson2NodeWire.scan(null));
        assertEquals(List.of(), Jackson2NodeWire.scan(""));
        assertEquals(List.of(), Jackson2NodeWire.scan("<html>not json</html>"));
    }

    @Test
    void assertCleanFailsOnTheLeakAndStaysSilentOtherwise() {
        Jackson2NodeWire.assertClean(HEALTHY_HOOKS, "GET /fixture");
        try {
            Jackson2NodeWire.assertClean(LEAKED, "GET /fixture");
            throw new AssertionError("assertClean must fail on the leaked shape");
        } catch (AssertionError expected) {
            assertTrue(expected.getMessage().contains("GET /fixture"),
                    "failure must name the request: " + expected.getMessage());
        }
    }
}
