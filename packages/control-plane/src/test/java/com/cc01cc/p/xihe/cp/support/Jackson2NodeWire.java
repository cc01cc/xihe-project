package com.cc01cc.p.xihe.cp.support;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.util.ArrayList;
import java.util.List;

import static org.junit.jupiter.api.Assertions.fail;

/**
 * PLAN-0633 C1-4 (D33-11): the runtime half of the "Jackson-2 node must never reach the wire" gate.
 *
 * <p>The static gate ({@code Jackson2NodeWireScanTest}) reasons about source shapes; this helper
 * reads what the server actually answered. The fingerprint is the <em>combination</em> Jackson 3
 * produces when it introspects a Jackson-2 node as an ordinary bean —
 * {@code {"array":false,…,"nodeType":"OBJECT",…}} — so a legitimate business document that happens
 * to carry a {@code nodeType} key is not a false positive:
 *
 * <pre>has("nodeType") &amp;&amp; (has("array") || has("containerNode") || has("missingNode") || has("valueNode"))</pre>
 *
 * <p>Wiring: {@link Jackson2NodeWireInterceptor} applies this to every response of the three
 * real-HTTP test base classes, so each existing assertion site gains the check for free.
 */
public final class Jackson2NodeWire {

    private static final ObjectMapper PARSER = new ObjectMapper();

    private static final List<String> BEAN_FINGERPRINT = List.of(
            "containerNode", "missingNode", "valueNode", "pojo", "nodeType");

    private Jackson2NodeWire() {}

    /** One detected leak: where in the document, and the offending key. */
    public record Leak(String path, String key) {
        @Override
        public String toString() {
            return path + " carried Jackson-2 bean metadata key '" + key + "'";
        }
    }

    /** Recursively scans a response body for the Jackson-2 bean fingerprint. Never throws on JSON. */
    public static List<Leak> scan(String body) {
        List<Leak> leaks = new ArrayList<>();
        if (body == null || body.isBlank()) {
            return leaks;
        }
        JsonNode root;
        try {
            root = PARSER.readTree(body);
        } catch (Exception error) {
            // Not JSON (HTML, empty, SSE frame): nothing to assert here.
            return leaks;
        }
        if (root != null) {
            walk(root, "$", leaks);
        }
        return leaks;
    }

    /** Fails the current test when the body carries the fingerprint; silent otherwise. */
    public static void assertClean(String body, String where) {
        List<Leak> leaks = scan(body);
        if (!leaks.isEmpty()) {
            fail("Jackson-2 JsonNode leaked to the wire at " + where + ": " + leaks
                    + ". A Jackson-2 node must leave the CP through JacksonNodeExit only (PLAN-0633 C1).");
        }
    }

    private static void walk(JsonNode node, String path, List<Leak> leaks) {
        if (node.isObject()) {
            if (node.has("nodeType")) {
                for (String key : BEAN_FINGERPRINT) {
                    if (!"nodeType".equals(key) && node.has(key)) {
                        leaks.add(new Leak(path, key));
                        break;
                    }
                }
            }
            node.fieldNames().forEachRemaining(name -> walk(node.get(name), path + "." + name, leaks));
        } else if (node.isArray()) {
            for (int index = 0; index < node.size(); index++) {
                walk(node.get(index), path + "[" + index + "]", leaks);
            }
        }
    }
}
