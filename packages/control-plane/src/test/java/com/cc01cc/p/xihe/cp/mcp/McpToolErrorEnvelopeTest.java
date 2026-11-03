package com.cc01cc.p.xihe.cp.mcp;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0649 M2 (T2.1, spec §1/§2 I2): the CP-owned tool error envelope carries a structured code
 * <b>beside</b> the byte-identical model-visible text, so the Agent classifies a refusal without
 * parsing {@code "Tool error:"}. Every CP call site (spawn / acquire / generic
 * {@code cpToolErrorResponse}) funnels through the one builder exercised here.
 *
 * <p>Code-only is the contract: {@code detail}/{@code status} would put CP internals (quota numbers,
 * HTTP status) on the wire, which spec §5 keeps off it. This is a plain unit test on purpose — the
 * envelope shape must not need a Spring context to be asserted.</p>
 */
class McpToolErrorEnvelopeTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final String BODY = "{\"jsonrpc\":\"2.0\",\"id\":7,\"method\":\"tools/call\"}";

    @Test
    void errorBranchCarriesStructuredCodeAndKeepsTheModelText() throws Exception {
        String json = McpProxyController.cpToolResult(MAPPER, BODY, null, "DELEGATION_LIMIT_EXCEEDED");

        JsonNode envelope = MAPPER.readTree(json);
        JsonNode result = envelope.path("result");

        assertEquals(7, envelope.path("id").asInt(), "the JSON-RPC id is echoed verbatim");
        assertTrue(result.path("isError").asBoolean());
        assertEquals("DELEGATION_LIMIT_EXCEEDED", result.path("structuredContent").path("code").asText());
        assertEquals(1, result.path("structuredContent").size(), "code only — no detail/status on the wire");
        assertEquals("Tool error: DELEGATION_LIMIT_EXCEEDED",
                result.path("content").get(0).path("text").asText(),
                "the model-visible text stays byte-identical to the pre-0649 envelope");
    }

    @Test
    void everyCpDecidedRefusalCodeRidesTheSameShape() throws Exception {
        for (String code : java.util.List.of("DELEGATION_LIMIT_EXCEEDED", "DELEGATION_POLICY_INVALID",
                "SPAWN_EXECUTION_FAILED", "ACQUIRE_EXECUTION_FAILED")) {
            JsonNode result = MAPPER.readTree(
                    McpProxyController.cpToolResult(MAPPER, BODY, null, code)).path("result");

            assertTrue(result.path("isError").asBoolean(), code);
            assertEquals(code, result.path("structuredContent").path("code").asText(), code);
            assertEquals("Tool error: " + code, result.path("content").get(0).path("text").asText(), code);
        }
    }

    @Test
    void successBranchIsUnchanged() throws Exception {
        JsonNode result = MAPPER.readTree(
                McpProxyController.cpToolResult(MAPPER, BODY, Map.of("ok", true), null)).path("result");

        assertFalse(result.path("isError").asBoolean(false));
        assertTrue(result.path("structuredContent").path("ok").asBoolean());
        assertEquals("{\"ok\":true}", result.path("content").get(0).path("text").asText());
        assertFalse(result.path("structuredContent").has("code"));
    }

    @Test
    void missingIdFallsBackToTheFrozenDefault() throws Exception {
        JsonNode envelope = MAPPER.readTree(
                McpProxyController.cpToolResult(MAPPER, "{}", null, "SPAWN_EXECUTION_FAILED"));

        assertEquals(1, envelope.path("id").asInt(),
                "the pre-0649 fallback id is preserved (modern clients need a non-null id)");
    }
}
