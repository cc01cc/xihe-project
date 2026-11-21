package com.cc01cc.p.xihe.cp.policy;

import ch.qos.logback.classic.Logger;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.core.read.ListAppender;
import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;

import java.util.List;
import java.util.Set;

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

    /**
     * task-53: the kind set is open (D25-10), so an unregistered kind must stay writable — but the
     * registry must expose it so the parse face is not silent, and it must still never dispatch.
     */
    @Test
    void unregisteredKindIsAcceptedButNeverDispatchedAndIsQueryable() throws Exception {
        JsonNode checked = HookAdvisorRegistry.validateSubscriptions(hooks(
                "{\"advisors\":[{\"kind\":\"future-plugin\",\"on\":[\"approval.ask\"]}]}"));
        HookAdvisorRegistry registry = new HookAdvisorRegistry(List.of(new FixedAdvisor("guard")));

        assertEquals(Set.of("future-plugin"),
                registry.unregisteredKinds(checked, HookAdvisorRegistry.ACTION_APPROVAL_ASK));
        assertTrue(registry.advisorsFor(checked, HookAdvisorRegistry.ACTION_APPROVAL_ASK).isEmpty(),
                "an unregistered kind must not select any advisor");
    }

    /** task-53: the parse-face warning is structured and deduplicated per action class + kind. */
    @Test
    void unregisteredKindWarnsOnceWithTheStructuredEvent() throws Exception {
        JsonNode checked = hooks(
                "{\"advisors\":[{\"kind\":\"future-plugin\",\"on\":[\"approval.ask\"]}]}");
        HookAdvisorRegistry registry = new HookAdvisorRegistry(List.of(new FixedAdvisor("guard")));

        Logger registryLogger = (Logger) LoggerFactory.getLogger(HookAdvisorRegistry.class);
        ListAppender<ILoggingEvent> appender = new ListAppender<>();
        appender.start();
        registryLogger.addAppender(appender);
        try {
            registry.advisorsFor(checked, HookAdvisorRegistry.ACTION_APPROVAL_ASK);
            registry.advisorsFor(checked, HookAdvisorRegistry.ACTION_APPROVAL_ASK);
        } finally {
            registryLogger.detachAppender(appender);
        }

        List<ILoggingEvent> warnings = appender.list.stream()
                .filter(event -> event.getFormattedMessage()
                        .contains("event=hook_advisor_kind_unregistered"))
                .toList();
        assertEquals(1, warnings.size(), "the same action class + kind warns exactly once per process");
        String message = warnings.get(0).getFormattedMessage();
        assertTrue(message.contains("actionClass=approval.ask"), message);
        assertTrue(message.contains("kind=future-plugin"), message);
    }

    /** task-53: the registered kind keeps dispatching, and emits no unregistered-kind warning. */
    @Test
    void registeredGuardStillDispatchesAndWarnsNothing() throws Exception {
        JsonNode checked = HookAdvisorRegistry.validateSubscriptions(hooks(
                "{\"advisors\":[{\"kind\":\"guard\",\"on\":[\"approval.ask\"]}]}"));
        HookAdvisorRegistry registry = new HookAdvisorRegistry(List.of(new FixedAdvisor("guard")));

        Logger registryLogger = (Logger) LoggerFactory.getLogger(HookAdvisorRegistry.class);
        ListAppender<ILoggingEvent> appender = new ListAppender<>();
        appender.start();
        registryLogger.addAppender(appender);
        try {
            List<HookAdvisor> selected =
                    registry.advisorsFor(checked, HookAdvisorRegistry.ACTION_APPROVAL_ASK);
            assertEquals(1, selected.size());
            assertEquals("guard", selected.get(0).kind());
        } finally {
            registryLogger.detachAppender(appender);
        }
        assertTrue(registry.unregisteredKinds(checked, HookAdvisorRegistry.ACTION_APPROVAL_ASK).isEmpty());
        assertTrue(appender.list.stream().noneMatch(event -> event.getFormattedMessage()
                .contains("event=hook_advisor_kind_unregistered")));
    }
}
