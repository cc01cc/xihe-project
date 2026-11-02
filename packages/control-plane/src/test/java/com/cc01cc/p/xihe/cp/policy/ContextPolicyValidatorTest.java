package com.cc01cc.p.xihe.cp.policy;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0629 M1 (D29-25): the single write-side gate for {@code agent_principals.context_policy}, pinned
 * on its own.
 *
 * <p>Why a dedicated unit test exists next to {@code AgentPrincipalContextPolicyHttpTest}: the HTTP
 * test proves the <i>chain</i> (controller → service → validator → JPA → wire), this one proves the
 * <i>gate</i> — the same way the project already separates "unit green ≠ chain green"; here the
 * inverse also matters, "chain green ≠ the single gate is pinned". The validator sits in the
 * {@code policy} package on purpose: the Agent side and the future UI backend are expected to reuse it,
 * so its contract must not depend on the HTTP surface.</p>
 *
 * <p>Two accepted shapes and eight refusals — the refusals are the user-facing contract, not
 * implementation details: everything that would store a policy the runtime cannot execute is a 400.</p>
 */
class ContextPolicyValidatorTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();

    // ---------------------------------------------------------------------------------------
    // accepted shapes
    // ---------------------------------------------------------------------------------------

    @Test
    void keepsTheFrozenV1DocumentAndTreatsNullAsClear() throws Exception {
        JsonNode document = json("""
                {"memory":{"enabled":true,"writeMode":"tool","types":["profile","fact"]}}
                """);

        assertEquals(document, ContextPolicyValidator.validate(document),
                "the frozen v1 document must validate unchanged");

        assertNull(ContextPolicyValidator.validate(null),
                "null means 'clear the column', not 'invalid'");
        assertNull(ContextPolicyValidator.validate(json("null")),
                "an explicit JSON null behaves like an absent document");
    }

    @Test
    void acceptsPartialDocumentsAndAnEmptyDocument() throws Exception {
        // Every memory field is optional: a document may switch memory on and leave the rest at the
        // documented defaults (writeMode=off, types=[]), and an empty document is the "no policy" form.
        for (String accepted : List.of(
                "{}",
                "{\"memory\":{}}",
                "{\"memory\":{\"enabled\":false}}",
                "{\"memory\":{\"enabled\":true}}",
                "{\"memory\":{\"writeMode\":\"off\"}}",
                "{\"memory\":{\"types\":[]}}")) {
            JsonNode document = json(accepted);
            assertEquals(document, ContextPolicyValidator.validate(document),
                    "must accept the partial document " + accepted);
        }
    }

    // ---------------------------------------------------------------------------------------
    // refusals
    // ---------------------------------------------------------------------------------------

    @Test
    void rejectsUnknownKeysAtBothLevels() {
        assertInvalid("{\"unknown\":1}", "unknown key(s): unknown");
        assertInvalid("{\"memory\":{\"unknown\":true}}", "unknown key(s): unknown");
    }

    @Test
    void rejectsANonObjectMemorySection() {
        assertInvalid("{\"memory\":\"nope\"}", "contextPolicy.memory must be an object");
    }

    @Test
    void rejectsANonBooleanEnabled() {
        assertInvalid("{\"memory\":{\"enabled\":\"yes\"}}", "enabled must be a boolean");
    }

    @Test
    void refusesTheReservedJudgeWriteModeWithTheRoadmapDetail() {
        CpApiException error = invalid("{\"memory\":{\"writeMode\":\"judge\"}}");
        assertEquals(HttpStatus.BAD_REQUEST, error.getStatus());
        assertEquals("INVALID_REQUEST", error.getCode());
        assertTrue(error.getMessage().contains("writeMode judge is not implemented in v1 (planned for M2)"),
                "the v1-reserved value must carry the roadmap detail: " + error.getMessage());
    }

    @Test
    void rejectsAnyWriteModeOutsideOffAndTool() {
        assertInvalid("{\"memory\":{\"writeMode\":\"auto\"}}", "writeMode must be \"off\" or \"tool\"");
        assertInvalid("{\"memory\":{\"writeMode\":42}}", "writeMode must be \"off\" or \"tool\"");
    }

    @Test
    void rejectsANonArrayTypesField() {
        assertInvalid("{\"memory\":{\"types\":\"profile\"}}", "types must be an array");
    }

    @Test
    void rejectsTypesOutsideTheFrozenVocabulary() {
        assertInvalid("{\"memory\":{\"types\":[\"secret\"]}}", "may only contain \"profile\" and \"fact\"");
        assertInvalid("{\"memory\":{\"types\":[\"profile\",1]}}", "may only contain \"profile\" and \"fact\"");
    }

    @Test
    void rejectsANonObjectRoot() {
        assertInvalid("[]", "contextPolicy must be an object");
        assertInvalid("\"memory\"", "contextPolicy must be an object");
    }

    // ---------------------------------------------------------------------------------------
    // helpers
    // ---------------------------------------------------------------------------------------

    private static JsonNode json(String raw) {
        try {
            return MAPPER.readTree(raw);
        } catch (Exception e) {
            throw new IllegalStateException("fixture JSON is invalid: " + raw, e);
        }
    }

    private static CpApiException invalid(String raw) {
        return assertThrows(CpApiException.class, () -> ContextPolicyValidator.validate(json(raw)),
                "must reject " + raw);
    }

    private static void assertInvalid(String raw, String expectedDetailFragment) {
        CpApiException error = invalid(raw);
        assertEquals(HttpStatus.BAD_REQUEST, error.getStatus(), raw);
        assertEquals("INVALID_REQUEST", error.getCode(), raw);
        assertTrue(error.getMessage().contains(expectedDetailFragment),
                raw + " → expected detail containing '" + expectedDetailFragment
                        + "' but was: " + error.getMessage());
    }
}
