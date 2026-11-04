package com.cc01cc.p.xihe.cp.policy;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0630 M1: the delegation-budget document has exactly one parser and two exits.
 *
 * <p>The matrix here is deliberately exhaustive on {@code 0} and on "looks numeric but is not an
 * integer": the sibling run-budget family treats {@code 0} as "dimension disabled / unlimited", and
 * copying that reading onto a delegation budget would turn a misconfiguration into "unlimited
 * fan-out". The two exits must also keep their distinct codes: a user typo is {@code 400
 * INVALID_REQUEST}, while an unreadable stored document fails the gate closed with {@code 409
 * DELEGATION_POLICY_INVALID}.</p>
 */
class DelegationPolicyValidatorTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();

    private static JsonNode json(String text) {
        try {
            return MAPPER.readTree(text);
        } catch (Exception error) {
            throw new AssertionError("bad fixture: " + text, error);
        }
    }

    // ---------------------------------------------------------------- write face

    @Test
    void acceptsBothKeysMissingKeysAndNull() {
        assertNull(DelegationPolicyValidator.validate(null), "null clears the column");
        assertNull(DelegationPolicyValidator.validate(json("null")), "JSON null clears the column");
        assertEquals(0, DelegationPolicyValidator.validate(json("{}")).size(),
                "{} means 'every key uses the code default'");
        assertEquals(2, DelegationPolicyValidator.validate(json("{\"maxCount\":8,\"maxDepth\":3}")).size());
        assertEquals(1, DelegationPolicyValidator.validate(json("{\"maxCount\":2}")).size(),
                "a single key is legal: the other falls back to its default");
    }

    @Test
    void rejectsNegativeFractionalAndTextualValues() {
        for (String bad : new String[] {
                "{\"maxDepth\":0}", "{\"maxCount\":-1}", "{\"maxDepth\":-2}",
                "{\"maxCount\":1.5}", "{\"maxDepth\":2.0}", "{\"maxCount\":\"8\"}", "{\"maxDepth\":\"3\"}",
                "{\"maxCount\":true}", "{\"maxDepth\":[]}", "{\"maxCount\":{\"v\":1}}"}) {
            CpApiException rejected = assertThrows(CpApiException.class,
                    () -> DelegationPolicyValidator.validate(json(bad)), "must reject " + bad);
            assertEquals(HttpStatus.BAD_REQUEST, rejected.getStatus(), bad);
            assertEquals("INVALID_REQUEST", rejected.getCode(), bad);
            assertTrue(rejected.getMessage().contains("delegationPolicy"), "detail names the document: " + bad);
        }
    }

    @Test
    void rejectsUnknownKeysAndNonObjectDocuments() {
        for (String bad : new String[] {"[]", "\"x\"", "42", "{\"maxConcurrent\":2}",
                "{\"maxCount\":2,\"maxDepth\":2,\"extra\":1}"}) {
            CpApiException rejected = assertThrows(CpApiException.class,
                    () -> DelegationPolicyValidator.validate(json(bad)), "must reject " + bad);
            assertEquals("INVALID_REQUEST", rejected.getCode(), bad);
        }
        CpApiException unknown = assertThrows(CpApiException.class,
                () -> DelegationPolicyValidator.validate(json("{\"maxConcurrent\":2}")));
        assertTrue(unknown.getMessage().contains("maxConcurrent"),
                "the refusal names the offending key: " + unknown.getMessage());
    }

    @Test
    void rejectsValuesAboveTheHardRails() {
        assertThrows(CpApiException.class, () -> DelegationPolicyValidator.validate(
                json("{\"maxCount\":" + (DelegationPolicyValidator.HARD_MAX_COUNT + 1) + "}")));
        assertThrows(CpApiException.class, () -> DelegationPolicyValidator.validate(
                json("{\"maxDepth\":" + (DelegationPolicyValidator.HARD_MAX_DEPTH + 1) + "}")));
    }

    // ---------------------------------------------------------------- read gate

    @Test
    void limitsFallsBackToTheCodeDefaults() {
        assertEquals(new DelegationPolicyValidator.DelegationLimits(8, 3),
                DelegationPolicyValidator.limits(null, 8, 3));
        assertEquals(new DelegationPolicyValidator.DelegationLimits(8, 3),
                DelegationPolicyValidator.limits(json("{}"), 8, 3));
        assertEquals(new DelegationPolicyValidator.DelegationLimits(2, 5),
                DelegationPolicyValidator.limits(json("{\"maxCount\":2,\"maxDepth\":5}"), 8, 3));
    }

    @Test
    void limitsAcceptsMaxCountZeroAsTheDelegationDisabledValue() {
        assertEquals(new DelegationPolicyValidator.DelegationLimits(0, 3),
                DelegationPolicyValidator.limits(json("{\"maxCount\":0}"), 8, 3),
                "maxCount=0 is the legal delegation-disabled value (ruling A1)");
    }

    @Test
    void limitsStillFailsClosedOnAMalformedDocument() {
        CpApiException rejected = assertThrows(CpApiException.class,
                () -> DelegationPolicyValidator.limits(json("{\"maxCount\":\"x\"}"), 8, 3));
        assertEquals(HttpStatus.CONFLICT, rejected.getStatus());
        assertEquals("DELEGATION_POLICY_INVALID", rejected.getCode());
    }

    @Test
    void limitsAcceptsExactlyTheHardRailsAndRefusesAboveThem() {
        JsonNode atRail = json("{\"maxCount\":" + DelegationPolicyValidator.HARD_MAX_COUNT + ","
                + "\"maxDepth\":" + DelegationPolicyValidator.HARD_MAX_DEPTH + "}");
        assertEquals(new DelegationPolicyValidator.DelegationLimits(
                        DelegationPolicyValidator.HARD_MAX_COUNT, DelegationPolicyValidator.HARD_MAX_DEPTH),
                DelegationPolicyValidator.limits(atRail, 8, 3), "the rail itself is legal");

        JsonNode aboveRail = json("{\"maxDepth\":" + (DelegationPolicyValidator.HARD_MAX_DEPTH + 1) + "}");
        CpApiException rejected = assertThrows(CpApiException.class,
                () -> DelegationPolicyValidator.limits(aboveRail, 8, 3));
        assertEquals("DELEGATION_POLICY_INVALID", rejected.getCode(),
                "an unreadable stored document fails the gate closed instead of being clamped");
    }
}
