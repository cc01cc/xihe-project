package com.cc01cc.p.xihe.cp.context;

import com.cc01cc.p.xihe.cp.context.service.ContextEventPayloadSafety;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0649 M2 (T2.2, spec §1/§3): durable {@code tool.result} may keep a <b>shape-checked</b>
 * refusal code, and nothing else may change.
 *
 * <p>Both directions matter and both run through {@link ContextEventPayloadSafety#sanitize}: the
 * inbound write and the read projection share this one implementation, so sanitizing twice is the
 * honest way to assert the read path without a second code path. The negative cases are the point
 * of the class: a code is an enum-shaped token, and anything that could carry content (spaces,
 * colons, newlines, non-ASCII, over-long) is dropped exactly like it was before this field existed.</p>
 */
class ContextEventPayloadSafetyRefusalCodeTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final String PLACEHOLDER = ContextEventPayloadSafety.UNSAFE_TOOL_RESULT_PLACEHOLDER;

    private static JsonNode sanitize(ObjectNode payload) {
        return ContextEventPayloadSafety.sanitize("tool.result", payload, MAPPER);
    }

    private static ObjectNode payload(String toolName, JsonNode result, String refusalCode) {
        ObjectNode payload = MAPPER.createObjectNode();
        payload.put("schemaVersion", 2);
        payload.put("toolCallId", "call-1");
        payload.put("toolName", toolName);
        payload.put("status", "failed");
        payload.set("result", result);
        if (refusalCode != null) {
            payload.put("refusalCode", refusalCode);
        }
        return payload;
    }

    @Test
    void shapeValidRefusalCodeSurvivesBothDirections() {
        ObjectNode raw = payload("spawn_agent", MAPPER.getNodeFactory().textNode(PLACEHOLDER),
                "DELEGATION_LIMIT_EXCEEDED");

        JsonNode inbound = sanitize(raw);
        JsonNode readBack = sanitize((ObjectNode) inbound);

        assertEquals("DELEGATION_LIMIT_EXCEEDED", inbound.path("refusalCode").asText());
        assertEquals("DELEGATION_LIMIT_EXCEEDED", readBack.path("refusalCode").asText());
        // I1: the body surface is untouched by the new field.
        assertEquals(PLACEHOLDER, inbound.path("result").asText());
        assertEquals("failed", inbound.path("status").asText());
    }

    @Test
    void malformedCodesAreDroppedAndNeverPersisted() {
        List<String> invalid = List.of(
                "DELEGATION LIMIT EXCEEDED",   // space
                "DELEGATION:LIMIT",            // colon
                "DELEGATION_LIMIT\nEXCEEDED",  // newline
                "DELEGATION_LIMIT_EXCEEDED_中", // non-ASCII
                "delegation_limit_exceeded",   // lowercase
                "1DELEGATION",                 // must start with a letter
                "_DELEGATION",                 // must start with a letter
                "A".repeat(65),                // over the 64-char bound
                "");                           // empty

        for (String code : invalid) {
            JsonNode safe = sanitize(payload("spawn_agent",
                    MAPPER.getNodeFactory().textNode(PLACEHOLDER), code));

            assertFalse(safe.has("refusalCode"),
                    "a malformed code must be dropped, got: " + safe.path("refusalCode").asText());
            assertFalse(safe.toString().contains(code.isEmpty() ? "refusalCode" : code),
                    "the rejected value must not survive anywhere in the payload: " + code);
            assertEquals(PLACEHOLDER, safe.path("result").asText());
        }
    }

    @Test
    void codeShapedAsContentCannotSmuggleTheBody() {
        // A non-skill tool: its body is fully withheld, so any occurrence of the marker would have
        // to have ridden in through the code field.
        ObjectNode result = MAPPER.createObjectNode();
        result.put("preview", "WORKSPACE-PRIVATE-BODY");
        result.put("truncated", false);
        ObjectNode raw = payload("write_file", result, "SKILL_BODY_WORKSPACE-PRIVATE-BODY");

        JsonNode safe = sanitize(raw);

        assertFalse(safe.toString().contains("WORKSPACE-PRIVATE-BODY"),
                "a code carrying content must be dropped, and the body must stay out");
        assertFalse(safe.has("refusalCode"));
    }

    @Test
    void refusedSkillReadKeepsItsCodeWhileTheBodyStaysWithheld() {
        String body = "SKILL-PRIVATE-BODY " + "x".repeat(6_000) + " SKILL-BODY-TAIL";
        ObjectNode result = MAPPER.createObjectNode();
        result.put("skillId", "11111111-1111-1111-1111-111111111111");
        result.put("body", body);

        JsonNode safe = sanitize(payload("skill_read", result, "SKILL_READ_UNAVAILABLE"));

        assertEquals("SKILL_READ_UNAVAILABLE", safe.path("refusalCode").asText(),
                "the skill_read branch must not swallow the refusal metadata");
        // skill_read keeps its own bounded metadata shape; the code is additive beside it, and the
        // body past the 256-char preview bound is still gone.
        assertTrue(safe.path("result").has("contentHash"));
        assertFalse(safe.toString().contains("SKILL-BODY-TAIL"),
                "the code must not become a second path for the withheld body");
    }

    @Test
    void plainFailedResultWithoutCodeKeepsThePreExistingShapeExactly() {
        JsonNode safe = sanitize(payload("write_file",
                MAPPER.getNodeFactory().textNode("Tool error: denied"), null));

        assertFalse(safe.has("refusalCode"), "absence stays absence (spec §1)");
        assertEquals(PLACEHOLDER, safe.path("result").asText());
        assertEquals("failed", safe.path("status").asText());
    }

    @Test
    void nonObjectPayloadPathIsUnchanged() {
        JsonNode safe = ContextEventPayloadSafety.sanitize("tool.result", "raw-string", MAPPER);

        assertEquals(PLACEHOLDER, safe.path("result").asText());
        assertFalse(safe.has("refusalCode"));
    }
}
