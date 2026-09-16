package com.cc01cc.p.xihe.cp.operation;

import com.cc01cc.p.xihe.cp.entity.OperationAttempt;
import com.cc01cc.p.xihe.cp.entity.OperationEvent;
import com.cc01cc.p.xihe.cp.entity.OperationItem;
import com.cc01cc.p.xihe.cp.entity.SessionOperation;
import org.junit.jupiter.api.Test;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0328 T1.15: item projections expose the safe `policy` snapshot on both the owner and
 * internal traces, and legacy / malformed rows simply omit it.
 */
class OperationViewsPolicyProjectionTest {

    private static final String SAFE_SUMMARY = "{\"effect\":\"ask\",\"sourceLayer\":\"builtin\","
            + "\"matchedRule\":\"{ write, \\\"*\\\", ask }\",\"reason\":\"requires approval for domain write\","
            + "\"mode\":\"auto\",\"allowedBy\":\"auto@session\",\"actionClass\":\"write\","
            + "\"shape\":\"structured\"}";

    private static OperationItem item(String policySummary) {
        OperationItem item = new OperationItem();
        item.setId(UUID.randomUUID());
        item.setOperationId(UUID.randomUUID().toString());
        item.setSequence(1);
        item.setKind("tool_call");
        item.setSource("mcp");
        item.setToolName("write_file");
        item.setPolicyDecision("allow");
        item.setPolicySummary(policySummary);
        item.setStatus("running");
        return item;
    }

    private static Map<String, Object> trace(OperationItem item) {
        SessionOperation operation = new SessionOperation();
        operation.setId(UUID.randomUUID());
        operation.setKind("chat");
        operation.setSource("agent");
        operation.setActorType("agent");
        operation.setStatus("running");
        Map<String, Object> trace = new LinkedHashMap<>();
        trace.put("operation", operation);
        trace.put("items", List.of(item));
        trace.put("attempts", List.<OperationAttempt>of());
        trace.put("events", List.<OperationEvent>of());
        return trace;
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> firstItem(Map<String, Object> view) {
        return ((List<Map<String, Object>>) view.get("items")).get(0);
    }

    @Test
    void ownerAndInternalTracesExposeTheExactSafePolicyProjection() {
        OperationItem item = item(SAFE_SUMMARY);

        Map<String, Object> ownerItem = firstItem(OperationViews.toUserTrace(trace(item)));
        Map<String, Object> internalItem = firstItem(OperationViews.toInternalTrace(trace(item)));

        for (Map<String, Object> projected : List.of(ownerItem, internalItem)) {
            Object policy = projected.get("policy");
            assertTrue(policy instanceof Map, "policy must be a typed object");
            Map<String, Object> summary = (Map<String, Object>) policy;
            assertEquals(OperationPolicySummary.POLICY_KEYS, summary.keySet());
            assertEquals("ask", summary.get("effect"));
            assertEquals("builtin", summary.get("sourceLayer"));
            assertEquals("auto", summary.get("mode"));
            assertEquals("auto@session", summary.get("allowedBy"));
            assertEquals("write", summary.get("actionClass"));
            assertEquals("structured", summary.get("shape"));
            // legacy marker stays untouched next to the new snapshot
            assertEquals("allow", projected.get("policyDecision"));
            assertFalse(summary.containsKey("arguments"));
            assertFalse(summary.containsKey("details"));
        }
    }

    @Test
    void preV19RowWithoutSnapshotOmitsPolicyButKeepsLegacyDecision() {
        Map<String, Object> ownerItem = firstItem(OperationViews.toUserTrace(trace(item(null))));

        assertFalse(ownerItem.containsKey("policy"));
        assertEquals("allow", ownerItem.get("policyDecision"));
    }

    @Test
    void malformedSnapshotIsOmittedInsteadOfGuessed() {
        Map<String, Object> ownerItem = firstItem(OperationViews.toUserTrace(
                trace(item("{\"effect\":\"ALLOW\",\"raw\":\"arguments\"}"))));

        assertFalse(ownerItem.containsKey("policy"));
    }
}
