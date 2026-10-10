package com.cc01cc.p.xihe.cp.context;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.annotation.JsonProperty;
import java.util.Map;

/** The fixed Context event read contract, independent of persistence fields. */
@JsonInclude(JsonInclude.Include.ALWAYS)
public record ContextEventResponse(
        @JsonProperty("aggregate_id") String aggregateId,
        Long sequence,
        String type,
        Map<String, Object> payload,
        @JsonProperty("created_at") String createdAt,
        @JsonProperty("correlation_id") String correlationId,
        @JsonProperty("causation_id") String causationId) {
}
