package com.cc01cc.p.xihe.cp.usage;

import com.cc01cc.p.xihe.cp.config.ConfigService;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import java.util.HashMap;
import java.util.Map;

/**
 * PLAN-0343 decision #7 / PLAN-0354 Q5-A: the single cost computation point
 * (pricing domain, per-MTok). Extracted verbatim from ChatController so both the
 * run-terminal usage snapshot and the compaction.applied usage sub-object map
 * cost the same way.
 *
 * <p>Contract: unmapped → {@code cost=null} + {@code costSource="unmapped"}
 * (never fabricate 0); rows without a model key or without token counts stay
 * verbatim / unpriced without pricing warn noise.
 */
@Component
public class UsageCostMapper {

    private static final Logger logger = LoggerFactory.getLogger(UsageCostMapper.class);

    private final ConfigService configService;
    private final ObjectMapper objectMapper;

    public UsageCostMapper(ConfigService configService, ObjectMapper objectMapper) {
        this.configService = configService;
        this.objectMapper = objectMapper;
    }

    /**
     * Enrich a usage snapshot with cost/costCurrency/costSource/costNote.
     *
     * @param model     pricing key (provider/model); null → verbatim copy
     * @param usage     usage map (0343 field names); empty → verbatim copy
     * @param contextId runId or sessionId for warn correlation
     */
    public Map<String, Object> withCost(String model, Map<String, Object> usage, String contextId) {
        if (usage == null || usage.isEmpty() || model == null || model.isBlank()) {
            return usage;
        }
        String source = stringValue(usage, "source");
        if (!"real".equals(source) && !"estimated".equals(source)) {
            // fallback: no counts → not priceable, cost stays absent-null.
            return withCostFields(usage, null, null, "unmapped", "no token counts");
        }
        java.math.BigDecimal[] rates = pricingRates(model);
        if (rates == null) {
            logger.warn("[LIFECYCLE] service=cp event=usage_cost_unmapped contextId={} model={} reason=no_pricing_entry",
                    contextId, model);
            return withCostFields(usage, null, null, "unmapped", "model not in pricing config");
        }
        long in = usage.get("inputTokens") instanceof Number n ? n.longValue() : 0L;
        long out = usage.get("outputTokens") instanceof Number n ? n.longValue() : 0L;
        java.math.BigDecimal cost = rates[0]
                .multiply(java.math.BigDecimal.valueOf(in))
                .divide(java.math.BigDecimal.valueOf(1_000_000))
                .add(rates[1]
                        .multiply(java.math.BigDecimal.valueOf(out))
                        .divide(java.math.BigDecimal.valueOf(1_000_000)));
        return withCostFields(usage, cost, "USD", "price_table", null);
    }

    /** per-MTok rates for {@code model} from the pricing domain, or null. [0]=input, [1]=output. */
    private java.math.BigDecimal[] pricingRates(String model) {
        Map<String, String> domain = configService.resolveDomain("pricing", null, null);
        String modelsJson = domain.get("models");
        if (modelsJson == null || modelsJson.isBlank()) {
            return null;
        }
        try {
            var models = objectMapper.readTree(modelsJson);
            var entry = models.path(model);
            if (entry.hasNonNull("inputPerMTok") && entry.hasNonNull("outputPerMTok")) {
                return new java.math.BigDecimal[]{
                        entry.get("inputPerMTok").decimalValue(),
                        entry.get("outputPerMTok").decimalValue()};
            }
            return null;
        } catch (Exception e) {
            logger.warn("[LIFECYCLE] service=cp event=pricing_config_unreadable model={} error={}", model, e.getMessage());
            return null;
        }
    }

    private Map<String, Object> withCostFields(Map<String, Object> usage,
                                               java.math.BigDecimal cost, String currency,
                                               String costSource, String costNote) {
        Map<String, Object> usageOut = new HashMap<>();
        for (Map.Entry<String, Object> entry : usage.entrySet()) {
            usageOut.put(entry.getKey(), entry.getValue());
        }
        usageOut.put("cost", cost);
        usageOut.put("costCurrency", cost != null ? currency : "USD");
        usageOut.put("costSource", costSource);
        usageOut.put("costNote", costNote);
        return usageOut;
    }

    private String stringValue(Map<String, Object> payload, String key) {
        Object value = payload.get(key);
        return value instanceof String string && !string.isBlank() ? string : null;
    }
}
