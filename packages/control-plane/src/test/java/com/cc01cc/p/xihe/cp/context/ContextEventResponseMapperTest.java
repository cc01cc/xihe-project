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
import com.cc01cc.p.xihe.cp.context.service.ContextEventPayloadSafety;
import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
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
        assertThat(mapper.replay(Map.of("snapshot", new ObjectMapper().createObjectNode(), "events", List.of()))
                .get("events")).isEmpty();
    }

    @Test
    void oldToolResultAndNativeCarrierRowsAreMaskedFromEventResponses() throws Exception {
        String canary = "legacy-event-response-canary";
        ObjectMapper payloadMapper = new ObjectMapper();
        var toolResult = event(payloadMapper.writeValueAsString(Map.of(
                "toolCallId", "legacy-call", "toolName", "read_file", "result", canary,
                "artifactRef", "artifact-" + canary)));
        toolResult.setEventType("tool.result");
        var carrier = event(payloadMapper.writeValueAsString(Map.of("message", Map.of(
                "role", "ai", "content", "done", "apiTypeId", "mimo-responses", "apiTypeVersion", 1,
                "nativeRecords", List.of(
                        Map.of("type", "function_call", "call_id", "call-1", "name", "read_file", "arguments", "{}"),
                        Map.of("type", "function_call_output", "call_id", "call-1", "output", canary))))));
        carrier.setEventType("assistant.responded");
        var prune = event(payloadMapper.writeValueAsString(Map.of("pruned_count", 1,
                "tombstones", List.of(Map.of("tool_call_id", "pruned-call", "sequence", 8,
                        "content_hash", "a".repeat(64), "head", canary, "tail", canary,
                        "reason", "oversized")))));
        prune.setEventType("context.prune");
        var fork = event(payloadMapper.writeValueAsString(Map.of("source_session_id", "source",
                "summary_seed", Map.of("contextEpoch", "child-epoch", "messages", List.of(
                        Map.of("role", "tool", "tool_name", "read_file", "content", canary,
                                "artifact_ref", "artifact-" + canary))))));
        fork.setEventType("session.forked");

        var responses = mapper.events(List.of(toolResult, carrier, prune, fork));
        String wire = wireMapper.writeValueAsString(responses);

        assertThat(wire).doesNotContain(canary, "artifact-" + canary);
        assertThat(wire).contains(ContextEventPayloadSafety.UNSAFE_TOOL_RESULT_PLACEHOLDER,
                "legacy-call", "call-1", "pruned-call");
        assertThat(wire).doesNotContain("head", "tail", "artifact_ref");
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
    void replayCarriesSnapshotTreeAndEventsWithoutMutatingEnvelope() {
        ObjectNode snapshot = new ObjectMapper().createObjectNode().put("latest_sequence", 3L);
        var originalEvents = List.of(event("{}"));
        Map<String, Object> original = new LinkedHashMap<>();
        original.put("snapshot", snapshot);
        original.put("events", originalEvents);

        var response = mapper.replay(original);

        assertThat(response.size()).isEqualTo(2);
        assertThat(response.get("snapshot")).isSameAs(snapshot);
        assertThat(response.get("events")).hasSize(1);
        assertThat(response.get("events").get(0).get("sequence")).isNotNull();
        // PLAN-0416 T2.4: the Spring Boot 4 converter runs Jackson 3, which
        // bean-serializes the Jackson 2 JsonNode into isInt/nodeType/pojo/...
        // metadata. The tree must travel as JSON, never as bean properties.
        assertThat(response.toString())
                .doesNotContain("nodeType", "bigDecimal", "\"pojo\"", "\"valueNode\"", "\"isInt\"");
        assertThat(original.get("events")).isSameAs(originalEvents);
        assertThat(original.get("snapshot")).isSameAs(snapshot);
    }

    @Test
    void replayRejectsSnapshotThatIsNotATree() {
        Map<String, Object> original = new LinkedHashMap<>();
        original.put("snapshot", new Object());
        original.put("events", List.of());
        assertSafeFailure(assertThrows(CpApiException.class, () -> mapper.replay(original)));
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
