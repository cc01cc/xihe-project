package com.cc01cc.p.xihe.cp.chat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.Test;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0666 M1a: the fingerprint calculator's whole contract is determinism (design D6, the head
 * acceptance item) and explicit representation of what the caller cannot see (D1/D3). These tests
 * are pure — no Spring, no database.
 */
class ContextFingerprintCalculatorTest {

    private static Map<String, Object> layers(Object history) {
        Map<String, Object> payloads = new LinkedHashMap<>();
        payloads.put("history", history);
        return payloads;
    }

    @Test
    void sameInputTwiceGivesTheSameHash() {
        Map<String, Object> input = layers(List.of(Map.of("role", "human", "content", "hello")));
        ObjectNode first = ContextFingerprintCalculator.calculate(input, Map.of("content", "hello"), 1);
        ObjectNode second = ContextFingerprintCalculator.calculate(input, Map.of("content", "hello"), 1);
        assertEquals(first, second, "the same input must serialize to the same document");
        assertEquals(
                first.path("layers").path("history").path("hash").asText(),
                second.path("layers").path("history").path("hash").asText());
        assertEquals(first.path("outbound").path("hash").asText(), second.path("outbound").path("hash").asText());
    }

    @Test
    void nestedMapInsertionOrderDoesNotMatter() {
        Map<String, Object> abc = new LinkedHashMap<>();
        abc.put("alpha", "1");
        abc.put("beta", Map.of("x", 1, "y", 2));
        abc.put("gamma", List.of(1, 2, 3));

        Map<String, Object> shuffled = new LinkedHashMap<>();
        shuffled.put("gamma", List.of(1, 2, 3));
        shuffled.put("alpha", "1");
        shuffled.put("beta", Map.of("y", 2, "x", 1));

        assertEquals(
                ContextFingerprintCalculator.hash(abc),
                ContextFingerprintCalculator.hash(shuffled),
                "canonical JSON must sort nested object keys, not rely on map iteration order");
        assertEquals(ContextFingerprintCalculator.canonicalJson(abc),
                "{\"alpha\":\"1\",\"beta\":{\"x\":1,\"y\":2},\"gamma\":[1,2,3]}");
    }

    @Test
    void numbersAreNormalizedAndNullDiffersFromMissingKey() {
        assertEquals(
                ContextFingerprintCalculator.hash(Map.of("n", 1)),
                ContextFingerprintCalculator.hash(Map.of("n", 1.0d)));
        assertEquals(
                ContextFingerprintCalculator.hash(Map.of("n", 1.5d)),
                ContextFingerprintCalculator.hash(Map.of("n", new java.math.BigDecimal("1.50"))));
        assertEquals("0", ContextFingerprintCalculator.canonicalJson(-0.0d));
        assertNotEquals(
                ContextFingerprintCalculator.hash(Map.of("a", 1)),
                ContextFingerprintCalculator.hash(Map.of("a", 2)));
        Map<String, Object> withNull = new LinkedHashMap<>();
        withNull.put("a", null);
        assertNotEquals(
                ContextFingerprintCalculator.hash(withNull),
                ContextFingerprintCalculator.hash(Map.of()),
                "an explicit null and a missing key are different inputs");
        assertEquals("{\"a\":null}", ContextFingerprintCalculator.canonicalJson(withNull));
        assertEquals("{}", ContextFingerprintCalculator.canonicalJson(Map.of()));
    }

    @Test
    void rejectsNonFiniteNumbersAndUnknownValueTypes() {
        assertThrows(IllegalArgumentException.class,
                () -> ContextFingerprintCalculator.hash(Map.of("n", Double.NaN)));
        assertThrows(IllegalArgumentException.class,
                () -> ContextFingerprintCalculator.hash(Map.of("n", Double.POSITIVE_INFINITY)));
        assertThrows(IllegalArgumentException.class,
                () -> ContextFingerprintCalculator.hash(Map.of("o", new Object())));
    }

    @Test
    void missingLayerIsExplicitAndUnavailableReasonIsCarried() {
        ObjectNode document = ContextFingerprintCalculator.calculate(
                Map.of("tools", new ContextFingerprintCalculator.Unavailable("agent_side")), null, 1);
        assertEquals(ContextFingerprintCalculator.LAYER_ORDER.size(), document.path("layers").size(),
                "every layer is present in the document — no silent omission");
        for (String layer : ContextFingerprintCalculator.LAYER_ORDER) {
            assertTrue(document.path("layers").has(layer), "missing layer in document: " + layer);
        }
        assertEquals("not_provided",
                document.path("layers").path("history").path("unavailable").asText());
        assertEquals("agent_side",
                document.path("layers").path("tools").path("unavailable").asText());
        assertEquals("not_provided", document.path("outbound").path("unavailable").asText());
        assertFalse(document.path("layers").path("history").has("hash"),
                "an unavailable layer must not pretend to have a hash");
    }

    @Test
    void unknownLayerNamesAreRejectedInsteadOfSilentlyDropped() {
        assertThrows(IllegalArgumentException.class,
                () -> ContextFingerprintCalculator.calculate(Map.of("historyy", List.of()), null, 1));
        assertThrows(IllegalArgumentException.class,
                () -> ContextFingerprintCalculator.calculate(Map.of(), null, 0),
                "dispatchAttempt is 1-based (design §2.2)");
    }

    @Test
    void layerCountsAndBytesDescribeTheCanonicalPayload() {
        List<Map<String, String>> messages = List.of(
                Map.of("role", "human", "content", "hello"),
                Map.of("role", "ai", "content", "world"));
        ObjectNode document = ContextFingerprintCalculator.calculate(
                layers(messages), Map.of("content", "hello"), 1);
        ObjectNode history = (ObjectNode) document.path("layers").path("history");
        assertEquals(2, history.path("count").asInt());
        assertEquals(ContextFingerprintCalculator.canonicalBytes(messages).length, history.path("bytes").asInt());
        assertEquals(1, document.path("dispatchAttempt").asInt());
        assertEquals(ContextFingerprintCalculator.ALGO, document.path("algo").asText());
    }

    @Test
    void fingerprintNeverContainsMessageContent() {
        String secret = "the-secret-user-prompt-do-not-leak";
        ObjectNode document = ContextFingerprintCalculator.calculate(
                layers(List.of(Map.of("role", "human", "content", secret))),
                Map.of("content", secret), 1);
        String serialized = document.toString();
        assertFalse(serialized.contains(secret), "fingerprint must not embed message content");
        assertFalse(serialized.contains("hello"), "no fragment of the payload either");
    }

    @Test
    void unavailableReasonIsRequired() {
        assertThrows(IllegalArgumentException.class,
                () -> new ContextFingerprintCalculator.Unavailable(" "));
    }

    @Test
    void nullAndMissingNestedValuesAreDistinguishable() {
        Map<String, Object> nested = new LinkedHashMap<>();
        nested.put("metadata", Map.of("sources", List.of()));
        JsonNode withEmpty = ContextFingerprintCalculator.calculate(layers(nested), null, 1)
                .path("layers").path("history");
        assertNotEquals(
                ContextFingerprintCalculator.hash(Map.of("metadata", Map.of("sources", List.of()))),
                ContextFingerprintCalculator.hash(Map.of("metadata", Map.of())),
                "empty array vs missing key must not collide");
        assertNotEquals(0, withEmpty.path("bytes").asInt());
    }
}
