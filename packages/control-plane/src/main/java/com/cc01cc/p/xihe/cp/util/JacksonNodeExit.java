package com.cc01cc.p.xihe.cp.util;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

/**
 * PLAN-0633 C1 (D33-09): the single exit for Jackson-2 trees that reach an HTTP response.
 *
 * <p>Boot 4 serialises HTTP bodies with Jackson 3 while this module still uses Jackson 2 for its
 * domain trees. A Jackson-2 {@link JsonNode} put straight into a response map (<em>or returned from
 * a controller</em>) is introspected by Jackson 3 as an ordinary bean, so the wire carries the node's
 * property names — the walked-through shapes were
 * {@code "hooks":{"array":false,…,"nodeType":"OBJECT",…}} (PLAN-0625 Gap J) and an always-empty
 * {@code hooks} projection (Gap I). Lower the tree to plain {@code Map}/{@code List}/scalars first;
 * {@code null} stays {@code null}.
 *
 * <p>Rule: a Jackson-2 node may only leave the CP through this class (or through an explicit scalar
 * projection such as {@code path(...).asText()}). The mechanical gates that enforce it live in
 * {@code Jackson2NodeWireScanTest} (static) and {@code Jackson2NodeWireInterceptor} (runtime).
 */
public final class JacksonNodeExit {

    private JacksonNodeExit() {}

    /**
     * Lowers one Jackson-2 node to plain JSON-compatible values.
     *
     * @param mapper the Jackson-2 mapper that owns the node (kept explicit: callers own the mapper
     *               configuration, this class owns the conversion rule)
     * @param node the node to lower; {@code null} and JSON {@code null} both map to {@code null}
     * @return a {@code Map}/{@code List}/scalar tree safe for Jackson-3 serialisation
     */
    public static Object toDocument(ObjectMapper mapper, JsonNode node) {
        return node == null || node.isNull() ? null : mapper.convertValue(node, Object.class);
    }
}
