package com.cc01cc.p.xihe.cp.context;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.junit.jupiter.api.Assertions.assertThrows;

import ch.qos.logback.classic.Logger;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.core.read.ListAppender;
import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.config.ProblemDetailsHandler;
import com.cc01cc.p.xihe.cp.context.entity.ContextEvent;
import com.fasterxml.jackson.annotation.JsonInclude;
import java.math.BigDecimal;
import java.math.BigInteger;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.NullSource;
import org.junit.jupiter.params.provider.ValueSource;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.mock.web.MockHttpServletRequest;
import tools.jackson.databind.json.JsonMapper;

class ContextEventResponseMapperTest {

    private static final String SESSION_ID = "10000000-0000-4000-8000-000000000001";
    private static final Instant CREATED_AT = Instant.parse("2026-10-09T03:00:00.123456789Z");
    private static final String DETAIL = "Context event response could not be constructed";

    private final ContextEventResponseMapper mapper = new ContextEventResponseMapper();
    private final JsonMapper wireMapper = JsonMapper.builder()
            .changeDefaultPropertyInclusion(inclusion -> inclusion
                    .withValueInclusion(JsonInclude.Include.NON_NULL))
            .build();

    @Test
    void serializesExactlySevenKeysIncludingNullIdentifiers() {
        var event = event("{\"nested\":{\"items\":[null,true,{\"name\":\"value\","
                + "\"large\":123456789012345678901234567890,"
                + "\"decimal\":0.123456789012345678901234567890}]},"
                + "\"large\":123456789012345678901234567890,"
                + "\"decimal\":0.123456789012345678901234567890}");
        var response = mapper.events(List.of(event)).getFirst();
        var wire = wireMapper.readTree(wireMapper.writeValueAsString(response));

        assertThat(wire.size()).isEqualTo(7);
        assertThat(wire.propertyNames()).containsExactlyInAnyOrder("aggregate_id", "sequence",
                "type", "payload", "created_at", "correlation_id", "causation_id");
        assertThat(wire.get("aggregate_id").asText()).isEqualTo(SESSION_ID);
        assertThat(wire.get("sequence").asLong()).isEqualTo(7L);
        assertThat(wire.get("type").asText()).isEqualTo("test.event");
        assertThat(wire.get("created_at").asText()).isEqualTo(CREATED_AT.toString());
        assertThat(wire.get("correlation_id").isNull()).isTrue();
        assertThat(wire.get("causation_id").isNull()).isTrue();
        assertThat(wire.get("payload").isObject()).isTrue();
        assertThat(wire.get("payload").get("nested").get("items").get(0).isNull()).isTrue();
        assertThat(wire.get("payload").get("nested").get("items").get(1).asBoolean()).isTrue();
        assertThat(wire.get("payload").get("nested").get("items").get(2)
                .get("name").asText()).isEqualTo("value");
        assertThat(response.payload().get("large"))
                .isEqualTo(new BigInteger("123456789012345678901234567890"));
        assertThat(response.payload().get("decimal"))
                .isEqualTo(new BigDecimal("0.123456789012345678901234567890"));
        var nested = (Map<?, ?>) response.payload().get("nested");
        var items = (List<?>) nested.get("items");
        var nestedNumbers = (Map<?, ?>) items.get(2);
        assertThat(nestedNumbers.get("large")).isEqualTo(response.payload().get("large"));
        assertThat(nestedNumbers.get("decimal")).isEqualTo(response.payload().get("decimal"));
        assertThat(wireMapper.writeValueAsString(response))
                .contains("123456789012345678901234567890", "0.123456789012345678901234567890")
                .doesNotContain("workspaceId", "userId", "branchId", "sessionId", "\"id\"");
    }

    @Test
    void preservesIdentifiersOrderAndEmptyLists() {
        var first = event("{}");
        first.setCorrelationId("10000000-0000-4000-8000-000000000005");
        first.setCausationId("10000000-0000-4000-8000-000000000006");
        var second = event("{}");
        second.setSequence(8L);
        var responses = mapper.events(List.of(first, second));
        assertThat(responses).extracting(ContextEventResponse::sequence).containsExactly(7L, 8L);
        assertThat(responses.getFirst().correlationId()).isEqualTo(first.getCorrelationId());
        assertThat(responses.getFirst().causationId()).isEqualTo(first.getCausationId());
        assertThat(mapper.events(List.of())).isEmpty();
        assertThat(mapper.replay(Map.of("snapshot", Map.of(), "events", List.of()))
                .get("events")).isEqualTo(List.of());
    }

    @ParameterizedTest
    @NullSource
    @ValueSource(strings = {"null", "[]", "\"text\"", "42", "true", "{invalid", "{} {}"})
    void rejectsInvalidPayloadAsSafeWholeListFailure(String payload) {
        var failure = assertThrows(CpApiException.class,
                () -> mapper.events(List.of(event("{}"), event(payload), event("{}"))));
        assertSafeFailure(failure);
    }

    @Test
    void conversionFailureAlsoUsesSafeError() {
        var event = event("{}");
        event.setCreatedAt(null);
        assertSafeFailure(assertThrows(CpApiException.class, () -> mapper.events(List.of(event))));
    }

    @Test
    void invalidJsonDoesNotLeakSyntheticSensitiveMarkerIntoLogsOrError() {
        String marker = "syntheticSensitiveMarker";
        Logger logger = (Logger) LoggerFactory.getLogger(ContextEventResponseMapper.class);
        Logger handlerLogger = (Logger) LoggerFactory.getLogger(ProblemDetailsHandler.class);
        ListAppender<ILoggingEvent> appender = new ListAppender<>();
        appender.start();
        logger.addAppender(appender);
        handlerLogger.addAppender(appender);
        try {
            var failure = assertThrows(CpApiException.class,
                    () -> mapper.events(List.of(event("{\"secret\":\"" + marker))));
            assertSafeFailure(failure);
            assertThat(failure.toString()).doesNotContain(marker);
            var request = new MockHttpServletRequest("GET", "/internal/v1/context/" + SESSION_ID + "/events");
            request.addHeader("X-Request-Id", "10000000-0000-4000-8000-000000000008");
            var problem = new ProblemDetailsHandler(5000L).badRequest(failure, request);
            assertThat(problem.getStatusCode()).isEqualTo(HttpStatus.INTERNAL_SERVER_ERROR);
            assertThat(problem.getBody()).containsEntry("detail", DETAIL).containsEntry("code", "INTERNAL_ERROR");
            assertThat(wireMapper.writeValueAsString(problem.getBody())).doesNotContain(marker, "secret");
            assertThat(appender.list).hasSize(2);
            assertThat(appender.list.getFirst().getFormattedMessage())
                    .contains(SESSION_ID, "sequence=7", "category=")
                    .doesNotContain(marker, "secret", "payload");
            assertThat(appender.list.getFirst().getThrowableProxy()).isNull();
            assertThat(appender.list).allSatisfy(logEvent -> {
                assertThat(logEvent.getFormattedMessage()).doesNotContain(marker, "secret");
                assertThat(logEvent.getThrowableProxy()).isNull();
            });
        } finally {
            logger.detachAppender(appender);
            handlerLogger.detachAppender(appender);
            appender.stop();
        }
    }

    @Test
    void replayOnlyReplacesEventsWithoutMutatingEnvelopeOrSnapshot() {
        Object snapshot = new com.fasterxml.jackson.databind.ObjectMapper().createObjectNode();
        var originalEvents = List.of(event("{}"));
        Map<String, Object> original = new LinkedHashMap<>();
        original.put("snapshot", snapshot);
        original.put("events", originalEvents);
        original.put("extra", Map.of("retained", true));
        original.put("nullable", null);
        var response = mapper.replay(original);
        assertThat(response).isNotSameAs(original).containsOnlyKeys("snapshot", "events", "extra", "nullable");
        assertThat(response.get("snapshot")).isSameAs(snapshot);
        assertThat(response.get("extra")).isSameAs(original.get("extra"));
        assertThat(response).containsEntry("nullable", null);
        assertThat(response.get("events")).isEqualTo(mapper.events(originalEvents));
        assertThat(original.get("events")).isSameAs(originalEvents);
        assertThat(original.get("snapshot")).isSameAs(snapshot);
    }

    @Test
    void replayFailureDoesNotMutateOriginalEnvelope() {
        Object snapshot = new Object();
        var originalEvents = List.of(event("{}"), event("[]"));
        Map<String, Object> original = new LinkedHashMap<>();
        original.put("snapshot", snapshot);
        original.put("events", originalEvents);
        original.put("extra", "unchanged");
        var before = new LinkedHashMap<>(original);
        assertSafeFailure(assertThrows(CpApiException.class, () -> mapper.replay(original)));
        assertThat(original).isEqualTo(before);
        assertThat(original.get("snapshot")).isSameAs(snapshot);
        assertThat(original.get("events")).isSameAs(originalEvents);
        assertThatThrownBy(() -> mapper.replay(Map.of("events", List.of("not an event"))))
                .isInstanceOf(CpApiException.class).hasMessage(DETAIL).hasNoCause();
    }

    private void assertSafeFailure(CpApiException failure) {
        assertThat(failure.getStatus()).isEqualTo(HttpStatus.INTERNAL_SERVER_ERROR);
        assertThat(failure.getCode()).isEqualTo("INTERNAL_ERROR");
        assertThat(failure.getMessage()).isEqualTo(DETAIL);
        assertThat(failure.getCause()).isNull();
    }

    private ContextEvent event(String payload) {
        var event = new ContextEvent(SESSION_ID, "10000000-0000-4000-8000-000000000002",
                "10000000-0000-4000-8000-000000000003", "test.event", 7L, payload);
        event.setId(UUID.fromString("10000000-0000-4000-8000-000000000004"));
        event.setBranchId("10000000-0000-4000-8000-000000000007");
        event.setCreatedAt(CREATED_AT);
        return event;
    }
}
