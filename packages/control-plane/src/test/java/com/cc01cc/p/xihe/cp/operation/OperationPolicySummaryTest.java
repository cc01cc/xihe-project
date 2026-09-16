package com.cc01cc.p.xihe.cp.operation;

import com.cc01cc.p.xihe.cp.policy.PolicyContext;
import com.cc01cc.p.xihe.cp.policy.PolicyEffect;
import com.cc01cc.p.xihe.cp.policy.PolicyLayer;
import com.cc01cc.p.xihe.cp.policy.PolicyVerdict;
import com.cc01cc.p.xihe.cp.policy.ToolFaceRegistry;
import com.cc01cc.p.xihe.cp.policy.ToolShape;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0328 T1.15: the operation ledger keeps a safe policy verdict snapshot — exact keys,
 * lower-case enum words, nullable descriptor fields, and never raw arguments or bodies.
 */
class OperationPolicySummaryTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();

    private static ToolFaceRegistry.Face readFace() {
        return new ToolFaceRegistry.Face("read", ToolShape.STRUCTURED);
    }

    @Test
    void allowSnapshot_carriesExactlyTheSafeKeysWithLowerCaseEnums() throws Exception {
        PolicyVerdict verdict = PolicyVerdict.of(PolicyEffect.ALLOW,
                "{ read, \"*\", allow }", PolicyLayer.BUILTIN, "manual", "allowed by read rules");

        String snapshot = OperationPolicySummary.buildSnapshot(
                verdict, readFace(), PolicyContext.EMPTY).orElseThrow();

        JsonNode root = MAPPER.readTree(snapshot);
        Set<String> keys = new HashSet<>();
        root.fieldNames().forEachRemaining(keys::add);
        assertEquals(OperationPolicySummary.POLICY_KEYS, keys);
        assertEquals(Set.of("effect", "sourceLayer", "matchedRule", "reason", "mode",
                "allowedBy", "actionClass", "shape", "reused"), keys);
        assertEquals("allow", root.get("effect").asText());
        assertEquals("builtin", root.get("sourceLayer").asText());
        assertEquals("{ read, \"*\", allow }", root.get("matchedRule").asText());
        assertEquals("allowed by read rules", root.get("reason").asText());
        assertEquals("manual", root.get("mode").asText());
        assertTrue(root.get("allowedBy").isNull());
        assertEquals("read", root.get("actionClass").asText());
        assertEquals("structured", root.get("shape").asText());
        assertTrue(root.get("reused").isNull());

        // No raw input surface may appear in the persisted snapshot.
        assertFalse(snapshot.contains("arguments"));
        assertFalse(snapshot.contains("details"));
        assertFalse(snapshot.contains("requestBody"));
        assertTrue(OperationPolicySummary.parse(snapshot).isPresent());
    }

    @Test
    void denySnapshot_keepsRuleAndLayerFromTheVerdict() {
        PolicyVerdict verdict = PolicyVerdict.of(PolicyEffect.DENY,
                "{ write, \"/etc/**\", deny }", PolicyLayer.WORKSPACE, "manual",
                "denied by { write, \"/etc/**\", deny } (write)");

        Map<String, Object> policy = OperationPolicySummary
                .buildSnapshot(verdict, new ToolFaceRegistry.Face("write", ToolShape.STRUCTURED),
                        PolicyContext.EMPTY)
                .flatMap(OperationPolicySummary::parse).orElseThrow();

        assertEquals("deny", policy.get("effect"));
        assertEquals("workspace", policy.get("sourceLayer"));
        assertEquals("{ write, \"/etc/**\", deny }", policy.get("matchedRule"));
        assertEquals("manual", policy.get("mode"));
        assertNull(policy.get("allowedBy"));
    }

    @Test
    void bypassAllow_recordsLowerCasedAllowedByMarker() {
        PolicyVerdict verdict = PolicyVerdict.of(PolicyEffect.ASK,
                "{ write, \"*\", ask }", PolicyLayer.SESSION, "auto", "requires approval")
                .allowedByMode("auto@SESSION");
        PolicyContext context = new PolicyContext(List.of(), Map.of(),
                "auto", PolicyLayer.SESSION);

        Map<String, Object> policy = OperationPolicySummary
                .buildSnapshot(verdict, new ToolFaceRegistry.Face("write", ToolShape.OPAQUE), context)
                .flatMap(OperationPolicySummary::parse).orElseThrow();

        assertEquals("allow", policy.get("effect"));
        assertEquals("auto", policy.get("mode"));
        assertEquals("auto@session", policy.get("allowedBy"));
        assertEquals("opaque", policy.get("shape"));
    }

    @Test
    void sessionModeIsPreferredOverVerdictMode() {
        PolicyVerdict verdict = PolicyVerdict.of(PolicyEffect.ASK,
                null, PolicyLayer.BUILTIN, null, "unclassified tool requires explicit classification");
        PolicyContext context = PolicyContext.failedClosed("manual");

        Map<String, Object> policy = OperationPolicySummary
                .buildSnapshot(verdict, readFace(), context)
                .flatMap(OperationPolicySummary::parse).orElseThrow();

        assertEquals("manual", policy.get("mode"));
    }

    @Test
    void incompleteDescriptorNeverThrowsAndYieldsEmpty() {
        assertTrue(OperationPolicySummary.buildSnapshot(null, readFace(), PolicyContext.EMPTY).isEmpty());
        assertTrue(OperationPolicySummary.buildSnapshot(
                PolicyVerdict.of(PolicyEffect.ALLOW, null, PolicyLayer.BUILTIN, "manual", "   "),
                readFace(), PolicyContext.EMPTY).isEmpty());
        assertTrue(OperationPolicySummary.buildSnapshot(
                PolicyVerdict.of(PolicyEffect.ALLOW, null, PolicyLayer.BUILTIN, "manual", "ok"),
                null, PolicyContext.EMPTY).isEmpty());
        assertTrue(OperationPolicySummary.buildSnapshot(
                PolicyVerdict.of(PolicyEffect.ALLOW, null, PolicyLayer.BUILTIN, "manual", "ok"),
                new ToolFaceRegistry.Face("  ", ToolShape.STRUCTURED), PolicyContext.EMPTY).isEmpty());
    }

    @Test
    void legacyAndMalformedSnapshotsAreOmittedNeverGuessed() {
        assertTrue(OperationPolicySummary.parse(null).isEmpty());
        assertTrue(OperationPolicySummary.parse("").isEmpty());
        assertTrue(OperationPolicySummary.parse("   ").isEmpty());
        assertTrue(OperationPolicySummary.parse("not-json").isEmpty());
        assertTrue(OperationPolicySummary.parse("{\"effect\":\"allow\"}").isEmpty());
        // extra keys are rejected: the shape is exact, not open
        assertTrue(OperationPolicySummary.parse("{\"effect\":\"allow\",\"sourceLayer\":\"builtin\","
                + "\"matchedRule\":null,\"reason\":\"ok\",\"mode\":null,\"allowedBy\":null,"
                + "\"actionClass\":\"read\",\"shape\":\"structured\",\"arguments\":\"raw\"}").isEmpty());
        // enum words must be lower-case
        assertTrue(OperationPolicySummary.parse("{\"effect\":\"ALLOW\",\"sourceLayer\":\"builtin\","
                + "\"matchedRule\":null,\"reason\":\"ok\",\"mode\":null,\"allowedBy\":null,"
                + "\"actionClass\":\"read\",\"shape\":\"structured\"}").isEmpty());
        assertTrue(OperationPolicySummary.parse("{\"effect\":\"allow\",\"sourceLayer\":\"builtin\","
                + "\"matchedRule\":null,\"reason\":\"ok\",\"mode\":null,\"allowedBy\":\"auto@SESSION\","
                + "\"actionClass\":\"read\",\"shape\":\"structured\"}").isEmpty());
        // missing nullable keys is also not the exact shape
        assertTrue(OperationPolicySummary.parse("{\"effect\":\"allow\",\"sourceLayer\":\"builtin\","
                + "\"matchedRule\":null,\"reason\":\"ok\",\"mode\":null,"
                + "\"actionClass\":\"read\",\"shape\":\"structured\"}").isEmpty());
    }

    @Test
    void parsedSnapshotIsTheExactSafeProjection() {
        String serialized = "{\"effect\":\"ask\",\"sourceLayer\":\"instance\","
                + "\"matchedRule\":\"{ exec, \\\"*\\\", ask }\",\"reason\":\"requires approval\","
                + "\"mode\":\"manual\",\"allowedBy\":null,\"actionClass\":\"exec\","
                + "\"shape\":\"interpreter\"}";

        Map<String, Object> policy = OperationPolicySummary.parse(serialized).orElseThrow();

        assertEquals(OperationPolicySummary.POLICY_KEYS, policy.keySet());
        assertEquals("ask", policy.get("effect"));
        assertEquals("instance", policy.get("sourceLayer"));
        assertEquals("{ exec, \"*\", ask }", policy.get("matchedRule"));
        assertEquals("requires approval", policy.get("reason"));
        assertEquals("manual", policy.get("mode"));
        assertNull(policy.get("allowedBy"));
        assertEquals("exec", policy.get("actionClass"));
        assertEquals("interpreter", policy.get("shape"));
        // T1.7: legacy V19 snapshots stay readable and report reuse as not applicable.
        assertNull(policy.get("reused"));
        assertFalse(policy.containsKey("arguments"));
        assertFalse(policy.containsKey("details"));
    }

    @Test
    void reuseAnnotationIsNullableAndStrictlyTyped() {
        PolicyVerdict verdict = PolicyVerdict.of(PolicyEffect.ALLOW,
                null, PolicyLayer.BUILTIN, "manual", "allowed");

        String hit = OperationPolicySummary
                .buildSnapshot(verdict, readFace(), PolicyContext.EMPTY, Boolean.TRUE).orElseThrow();
        assertEquals(Boolean.TRUE,
                OperationPolicySummary.parse(hit).orElseThrow().get("reused"));

        String notApplicable = OperationPolicySummary
                .buildSnapshot(verdict, readFace(), PolicyContext.EMPTY, null).orElseThrow();
        Map<String, Object> parsed = OperationPolicySummary.parse(notApplicable).orElseThrow();
        assertNull(parsed.get("reused"));

        // A non-boolean reuse annotation makes the snapshot unreadable, never guessed.
        assertTrue(OperationPolicySummary.parse("{\"effect\":\"allow\",\"sourceLayer\":\"builtin\","
                + "\"matchedRule\":null,\"reason\":\"ok\",\"mode\":null,\"allowedBy\":null,"
                + "\"actionClass\":\"read\",\"shape\":\"structured\",\"reused\":\"yes\"}").isEmpty());
    }
}
