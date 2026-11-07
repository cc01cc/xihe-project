package com.cc01cc.p.xihe.cp.plugin.kv;

import tools.jackson.databind.JsonNode;

/**
 * PLAN-0691 T1.5: body of {@code PUT /internal/v1/plugin-bindings/{bindingId}/kv/{namespace}/{key}}
 * (spec/data-plane.md API-2: {@code {value, ttlSeconds?, ifMatch?}}).
 *
 * <p>{@code value} is a Jackson <b>3</b> node: the request document is arbitrary JSON and must be
 * stored as-is, so it is taken as a tree rather than as a typed DTO. It is serialised exactly once on
 * the way in (size check + storage) so the byte budget QUOTA-2 measures is the byte budget that gets
 * persisted.
 *
 * <p>{@code ttlSeconds} and {@code ifMatch} are boxed so "absent" and "zero" stay distinguishable —
 * an absent TTL means "no expiry" while {@code ttlSeconds: 0} is a request error.
 */
public record PluginKvPutRequest(JsonNode value, Long ttlSeconds, Long ifMatch) {
}
