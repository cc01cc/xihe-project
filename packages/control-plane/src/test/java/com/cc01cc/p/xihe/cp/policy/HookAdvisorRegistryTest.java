package com.cc01cc.p.xihe.cp.policy;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0625 M2 (D25-12/14): subscription validation is one place, and the registry filters
 * advisors by the principal row's {@code on} whitelist with exact action-class matching.
 */
class HookAdvisorRegistryTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();

    private static JsonNode hooks(String json) throws Exception {
        return MAPPER.readTree(json);
    }

    private record FixedAdvisor(String kind) implements HookAdvisor {
        @Override
        public String kind() {
            return kind;
        }

        @Override
        public HookVerdict advise(HookInvocation invocation) {
            return HookVerdict.allow("test");
        }
    }

    @Test
    void nullHooksMeansNoSubscriptionsAndIsValid() {
        assertNull(HookAdvisorRegistry.validateSubscriptions(null));
        HookAdvisorRegistry registry = new HookAdvisorRegistry(List.of(new FixedAdvisor("guard")));
        assertTrue(registry.advisorsFor(null, HookAdvisorRegistry.ACTION_APPROVAL_ASK).isEmpty());
    }

    @Test
    void wellFormedSubscriptionPassesAndSelectsTheAdvisor() throws Exception {
        JsonNode checked = HookAdvisorRegistry.validateSubscriptions(hooks(
                "{\"advisors\":[{\"kind\":\"guard\",\"on\":[\"approval.ask\"]}]}"));
        HookAdvisorRegistry registry = new HookAdvisorRegistry(List.of(new FixedAdvisor("guard")));
        List<HookAdvisor> selected = registry.advisorsFor(checked, HookAdvisorRegistry.ACTION_APPROVAL_ASK);
        assertEquals(1, selected.size());
        assertEquals("guard", selected.get(0).kind());
        // exact match: another action class selects nothing
        assertTrue(registry.advisorsFor(checked, "approval.unknown").isEmpty());
    }

    @Test
    void unknownActionClassInOnIsRejectedWith400() throws Exception {
        JsonNode bad = hooks("{\"advisors\":[{\"kind\":\"guard\",\"on\":[\"approval.*\"]}]}");
        CpApiException error = assertThrows(CpApiException.class,
                () -> HookAdvisorRegistry.validateSubscriptions(bad));
        assertEquals(HttpStatus.BAD_REQUEST, error.getStatus());
        assertEquals("INVALID_REQUEST", error.getCode());
    }

    @Test
    void blankKindIsRejected() throws Exception {
        JsonNode bad = hooks("{\"advisors\":[{\"kind\":\" \",\"on\":[\"approval.ask\"]}]}");
        assertThrows(CpApiException.class, () -> HookAdvisorRegistry.validateSubscriptions(bad));
    }

    @Test
    void emptyOnListIsRejected() throws Exception {
        JsonNode bad = hooks("{\"advisors\":[{\"kind\":\"guard\",\"on\":[]}]}");
        assertThrows(CpApiException.class, () -> HookAdvisorRegistry.validateSubscriptions(bad));
    }

    @Test
    void nonObjectHooksDocumentIsRejected() throws Exception {
        assertThrows(CpApiException.class,
                () -> HookAdvisorRegistry.validateSubscriptions(MAPPER.readTree("[\"guard\"]")));
    }
}
