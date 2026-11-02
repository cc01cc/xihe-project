package com.cc01cc.p.xihe.cp.util;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0633 C1: the single sanctioned Jackson-2 → wire exit.
 *
 * <p>The two overloads must stay behaviourally identical: the no-mapper one exists only because
 * static helpers (reached from tests without a Spring context) hold no mapper, and lowering a tree
 * reads the tree alone — never a mapper feature. This test is what keeps that claim honest.
 */
class JacksonNodeExitTest {

    private final ObjectMapper mapper = new ObjectMapper();

    @Test
    void nullNodeAndJsonNullBothLowerToNull() throws Exception {
        assertNull(JacksonNodeExit.toDocument(null));
        assertNull(JacksonNodeExit.toDocument(mapper, null));
        assertNull(JacksonNodeExit.toDocument(mapper.readTree("null")));
        assertNull(JacksonNodeExit.toDocument(mapper, mapper.readTree("null")));
    }

    @Test
    void loweringProducesPlainJsonValues() throws Exception {
        JsonNode tree = mapper.readTree("{\"a\":{\"b\":[1,2,3]},\"c\":\"x\",\"d\":true}");

        Object lowered = JacksonNodeExit.toDocument(tree);

        assertTrue(lowered instanceof Map, "lowered root must be a Map, was " + lowered.getClass());
        @SuppressWarnings("unchecked")
        Map<String, Object> document = (Map<String, Object>) lowered;
        assertTrue(document.get("a") instanceof Map, "nested object must be a Map");
        assertTrue(((Map<?, ?>) document.get("a")).get("b") instanceof List, "array must be a List");
        assertEquals("x", document.get("c"));
        assertEquals(Boolean.TRUE, document.get("d"));
    }

    @Test
    void bothOverloadsAgreeRegardlessOfTheCallerMapper() throws Exception {
        JsonNode tree = mapper.readTree("{\"a\":{\"b\":[1,2,3]},\"c\":\"x\"}");

        assertEquals(JacksonNodeExit.toDocument(tree), JacksonNodeExit.toDocument(mapper, tree));
    }
}
