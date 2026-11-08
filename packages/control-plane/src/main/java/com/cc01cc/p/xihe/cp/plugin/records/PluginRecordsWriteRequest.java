package com.cc01cc.p.xihe.cp.plugin.records;

import tools.jackson.databind.JsonNode;

/**
 * PLAN-0691 T2.3: the write body of {@code POST /records/{collection}} and
 * {@code PUT /records/{collection}/{id}} (spec/data-plane.md API-5/API-10).
 *
 * <p>The wrapper exists so the document is <i>named</i>: a bare JSON body would make every future
 * field ambiguous with document content, and the {@code doc} value is stored verbatim as DP-2's
 * {@code jsonb} column. The node is a Jackson 3 node on purpose — Jackson 2 nodes must never cross the
 * wire (PLAN-0633 C1).
 *
 * @param doc the document to store; validated as a JSON object by the service
 */
public record PluginRecordsWriteRequest(JsonNode doc) {
}
