package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import org.junit.jupiter.api.Test;

import java.util.LinkedHashMap;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

class ApprovalControllerTest {

    @Test
    void scalarRuleIsRejected() {
        CpApiException error = assertInvalid(Map.of("decision", "saved", "rule", "write"));

        assertEquals("rule must be an object", error.getMessage());
    }

    @Test
    void nonStringRuleActionClassIsRejected() {
        Map<String, Object> rule = new LinkedHashMap<>();
        rule.put("actionClass", 42);

        CpApiException error = assertInvalid(Map.of("decision", "saved", "rule", rule));

        assertEquals("rule.actionClass must be a string", error.getMessage());
    }

    @Test
    void nonStringRuleResourceIsRejected() {
        Map<String, Object> rule = new LinkedHashMap<>();
        rule.put("resource", new String[] {"src/**"});

        CpApiException error = assertInvalid(Map.of("decision", "saved", "rule", rule));

        assertEquals("rule.resource must be a string", error.getMessage());
    }

    @Test
    void validRulePreservesStringsAndDefaultsOmittedResource() {
        Map<String, Object> rule = new LinkedHashMap<>();
        rule.put("actionClass", "write");

        ApprovalDecision decision = ApprovalController.parseDecision(
                Map.of("decision", "saved", "rule", rule));

        assertEquals(ApprovalDecision.Kind.SAVED, decision.kind());
        assertEquals("write", decision.actionClass());
        assertEquals("*", decision.effectiveResource());
    }

    @Test
    void validRulePreservesExplicitResource() {
        Map<String, Object> rule = Map.of("actionClass", "write", "resource", "src/**");

        ApprovalDecision decision = ApprovalController.parseDecision(
                Map.of("decision", "saved", "rule", rule));

        assertEquals("write", decision.actionClass());
        assertEquals("src/**", decision.resource());
    }

    private static CpApiException assertInvalid(Map<String, Object> body) {
        CpApiException error = assertThrows(CpApiException.class,
                () -> ApprovalController.parseDecision(body));
        assertEquals(400, error.getStatus().value());
        assertEquals("INVALID_REQUEST", error.getCode());
        return error;
    }
}
