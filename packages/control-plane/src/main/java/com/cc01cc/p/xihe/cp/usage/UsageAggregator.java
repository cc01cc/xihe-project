package com.cc01cc.p.xihe.cp.usage;

import com.cc01cc.p.xihe.cp.context.entity.ContextEvent;
import com.cc01cc.p.xihe.cp.context.service.EventStoreService;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.math.BigDecimal;
import java.util.List;
import java.util.UUID;

/**
 * PLAN-0343 decision #5: internal read-only aggregation over the session's
 * llm.usage context events (mirrored from the llm_usage ledger extensions).
 * NOT a public API surface — consumers are tests and PLAN-0355 back-testing.
 *
 * Recomputation contract (V3): sums are derived from the per-run snapshots;
 * legacy rows without a {@code model} key count toward {@code partial} but
 * contribute nothing to cost sums and never trigger alerts (spec §2.2).
 *
 * PLAN-0410 T2.2: aggregation runs on ONE branch path — a sibling branch's
 * usage never enters this branch's sums.
 */
@Service
public class UsageAggregator {

    private static final Logger log = LoggerFactory.getLogger(UsageAggregator.class);

    private final EventStoreService eventStore;
    private final com.cc01cc.p.xihe.cp.service.BranchPathService branchPathService;
    private final ObjectMapper objectMapper;

    public UsageAggregator(EventStoreService eventStore,
                           com.cc01cc.p.xihe.cp.service.BranchPathService branchPathService,
                           ObjectMapper objectMapper) {
        this.eventStore = eventStore;
        this.branchPathService = branchPathService;
        this.objectMapper = objectMapper;
    }

    /**
     * Aggregated usage for the Session root path (legacy selector-less entry;
     * a Session without a root row can only hold Session/global events).
     */
    public Agg aggregate(UUID sessionId) {
        return aggregate(sessionId, null);
    }

    /**
     * Aggregated usage visible on {@code branchId}'s path. {@code branchId}
     * null selects the Session root path; a supplied foreign/forged branch
     * fails closed via branch path resolution.
     *
     * <p>{@code sumCost} is null when no row carries a cost; {@code partial} is
     * true when any snapshot lacks a computable cost (unmapped, fallback or
     * legacy row without a model key).
     */
    public Agg aggregate(UUID sessionId, String branchId) {
        long sumIn = 0;
        long sumOut = 0;
        BigDecimal sumCost = null;
        int withCost = 0;
        int withoutCost = 0;
        String branch = (branchId == null || branchId.isBlank())
                ? null
                : branchId;
        var visibility = (branch == null)
                ? branchPathService.rootVisibility(sessionId.toString())
                : branchPathService.resolveVisibility(sessionId.toString(), branch);
        List<ContextEvent> events = eventStore.read(sessionId.toString(), 0L, visibility);
        for (ContextEvent event : events) {
            if (!"llm.usage".equals(event.getEventType())) {
                continue;
            }
            try {
                JsonNode envelope = objectMapper.readTree(event.getPayload());
                JsonNode usage = envelope.path("usage");
                if (usage.isMissingNode() || !usage.isObject()) {
                    withoutCost++;
                    continue;
                }
                sumIn += usage.path("inputTokens").asLong(0);
                sumOut += usage.path("outputTokens").asLong(0);
                JsonNode cost = usage.path("cost");
                if (cost.isNumber()) {
                    sumCost = sumCost == null ? cost.decimalValue() : sumCost.add(cost.decimalValue());
                    withCost++;
                } else {
                    withoutCost++;
                }
            } catch (Exception e) {
                log.warn("[LIFECYCLE] service=cp event=usage_aggregate_row_failed sessionId={} error={}",
                        sessionId, e.getMessage());
                withoutCost++;
            }
        }
        return new Agg(sumIn, sumOut, sumCost, withCost, withoutCost, withoutCost > 0);
    }

    public record Agg(long sumInputTokens, long sumOutputTokens, BigDecimal sumCost,
                      int runsWithCost, int runsWithoutCost, boolean partial) {}
}
