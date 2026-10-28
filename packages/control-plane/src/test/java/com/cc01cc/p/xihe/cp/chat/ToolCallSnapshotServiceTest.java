package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.context.entity.ContextEvent;
import com.cc01cc.p.xihe.cp.context.repository.EventStoreRepository;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

class ToolCallSnapshotServiceTest {

    private static final String SESSION_ID = "5e5510aa-0000-0000-0000-000000000001";
    private static final String RUN_ID = "c0ffee00-0000-0000-0000-000000000001";

    private final ObjectMapper objectMapper = new ObjectMapper();
    private final EventStoreRepository repository = mock(EventStoreRepository.class);
    private final Instant start = Instant.parse("2026-10-28T10:00:00Z");

    private ToolCallSnapshotService service;

    @BeforeEach
    void setUp() {
        service = new ToolCallSnapshotService(repository, objectMapper);
    }

    @Test
    void buildsV2CardsWithPlaceholderResult() throws Exception {
        stub(
                event("tool.called", start, """
                        {"schemaVersion":2,"toolCallId":"c1","toolName":"read_file",
                         "runId":"%s","arguments":{"path":"src/main.rs"}}""".formatted(RUN_ID)),
                event("tool.result", start.plusSeconds(2), """
                        {"schemaVersion":2,"toolCallId":"c1","toolName":"read_file",
                         "runId":"%s","status":"completed","result":"placeholder"}""".formatted(RUN_ID)));

        JsonNode root = objectMapper.readTree(service.snapshotJson(SESSION_ID, RUN_ID));
        JsonNode call = root.path("calls").get(0);
        assertEquals("c1", call.path("id").asText());
        assertEquals("read_file", call.path("name").asText());
        assertEquals("{\"path\":\"src/main.rs\"}", call.path("arguments").asText());
        assertEquals("completed", call.path("status").asText());
        assertEquals("2026-10-28T10:00:00Z", call.path("startedAt").asText());
        assertEquals("2026-10-28T10:00:02Z", call.path("completedAt").asText());
        assertEquals("placeholder", call.path("result").asText());
        assertFalse(call.path("truncated").asBoolean());
    }

    @Test
    void buildsLegacyCardsAndMapsFailedStatus() throws Exception {
        stub(
                event("tool.called", start, """
                        {"call_id":"c-legacy","tool_name":"execute_command","tool_input":{"command":"cargo test"}}"""),
                event("tool.result", start.plusSeconds(1), """
                        {"call_id":"c-legacy","tool_name":"execute_command","status":"failed","result":"boom"}"""));

        JsonNode call = objectMapper.readTree(service.snapshotJson(SESSION_ID, RUN_ID)).path("calls").get(0);
        assertEquals("c-legacy", call.path("id").asText());
        assertEquals("execute_command", call.path("name").asText());
        assertEquals("{\"command\":\"cargo test\"}", call.path("arguments").asText());
        assertEquals("failed", call.path("status").asText());
        assertEquals("boom", call.path("result").asText());
    }

    @Test
    void keepsCalledWithoutResultAsRunning() throws Exception {
        stub(event("tool.called", start, """
                {"call_id":"c1","tool_name":"read_file","tool_input":{"path":"a"}}"""));

        JsonNode call = objectMapper.readTree(service.snapshotJson(SESSION_ID, RUN_ID)).path("calls").get(0);
        assertEquals("running", call.path("status").asText());
        assertFalse(call.has("completedAt"));
    }

    @Test
    void excludesApprovalToolAndSkipsMissingIdentity() throws Exception {
        stub(
                event("tool.called", start, """
                        {"call_id":"approval","tool_name":"request_approval","tool_input":{"action":"x"}}"""),
                event("tool.called", start.plusSeconds(1), """
                        {"call_id":"c1","tool_name":"read_file","tool_input":{}}"""));

        JsonNode calls = objectMapper.readTree(service.snapshotJson(SESSION_ID, RUN_ID)).path("calls");
        assertEquals(1, calls.size());
        assertEquals("c1", calls.get(0).path("id").asText());
    }

    @Test
    void firstResultWins() throws Exception {
        stub(
                event("tool.called", start, """
                        {"call_id":"c1","tool_name":"read_file","tool_input":{}}"""),
                event("tool.result", start.plusSeconds(1), """
                        {"call_id":"c1","tool_name":"read_file","status":"completed","result":"first"}"""),
                event("tool.result", start.plusSeconds(2), """
                        {"call_id":"c1","tool_name":"read_file","status":"failed","result":"second"}"""));

        JsonNode call = objectMapper.readTree(service.snapshotJson(SESSION_ID, RUN_ID)).path("calls").get(0);
        assertEquals("completed", call.path("status").asText());
        assertEquals("first", call.path("result").asText());
    }

    @Test
    void boundsOversizedArgumentsWithMarker() throws Exception {
        String huge = "x".repeat(5000);
        stub(event("tool.called", start, objectMapper.writeValueAsString(
                java.util.Map.of("call_id", "c1", "tool_name", "read_file", "tool_input",
                        java.util.Map.of("blob", huge)))));

        JsonNode call = objectMapper.readTree(service.snapshotJson(SESSION_ID, RUN_ID)).path("calls").get(0);
        assertTrue(call.path("truncated").asBoolean());
        String args = call.path("arguments").asText();
        assertTrue(args.length() <= ToolCallSnapshotService.ARG_LIMIT);
        JsonNode marker = objectMapper.readTree(args);
        assertTrue(marker.path("__xihe_truncated__").asBoolean());
        assertTrue(marker.path("__chars__").asInt() > 4096);
    }

    @Test
    void capsCardCountAndReportsTotal() throws Exception {
        List<ContextEvent> events = new ArrayList<>();
        for (int i = 0; i < ToolCallSnapshotService.MAX_CALLS + 1; i++) {
            events.add(event("tool.called", start.plusMillis(i), objectMapper.writeValueAsString(
                    java.util.Map.of("call_id", "c" + i, "tool_name", "read_file", "tool_input", java.util.Map.of()))));
        }
        stub(events.toArray(ContextEvent[]::new));

        JsonNode root = objectMapper.readTree(service.snapshotJson(SESSION_ID, RUN_ID));
        assertEquals(ToolCallSnapshotService.MAX_CALLS, root.path("calls").size());
        assertEquals(ToolCallSnapshotService.MAX_CALLS + 1, root.path("total").asInt());
        assertTrue(root.path("truncated").asBoolean());
    }

    @Test
    void keepsMessageBudgetForManyLargeArguments() throws Exception {
        List<ContextEvent> events = new ArrayList<>();
        String huge = "y".repeat(4000);
        for (int i = 0; i < 30; i++) {
            events.add(event("tool.called", start.plusMillis(i), objectMapper.writeValueAsString(
                    java.util.Map.of("call_id", "c" + i, "tool_name", "read_file", "tool_input",
                            java.util.Map.of("blob", huge)))));
        }
        stub(events.toArray(ContextEvent[]::new));

        String json = service.snapshotJson(SESSION_ID, RUN_ID);
        assertTrue(json.getBytes(java.nio.charset.StandardCharsets.UTF_8).length
                <= ToolCallSnapshotService.MESSAGE_BUDGET_BYTES);
        JsonNode root = objectMapper.readTree(json);
        assertEquals(30, root.path("calls").size());
        assertTrue(root.path("calls").get(0).path("truncated").asBoolean());
    }

    @Test
    void extractsPreviewFromLegacyObjectResult() throws Exception {
        stub(
                event("tool.called", start, """
                        {"call_id":"c1","tool_name":"read_file","tool_input":{}}"""),
                event("tool.result", start.plusSeconds(1), """
                        {"call_id":"c1","tool_name":"read_file",
                         "result":{"preview":"preview-text","truncated":true}}"""));

        JsonNode call = objectMapper.readTree(service.snapshotJson(SESSION_ID, RUN_ID)).path("calls").get(0);
        assertEquals("preview-text", call.path("result").asText());
    }

    @Test
    void returnsNullForEmptyOrFailedProjection() {
        stub();
        assertNull(service.snapshotJson(SESSION_ID, RUN_ID));

        when(repository.findBySessionIdAndCorrelationIdAndEventTypeInOrderByCreatedAtAscIdAsc(eq(SESSION_ID), eq(RUN_ID), any()))
                .thenThrow(new IllegalStateException("boom"));
        assertNull(service.snapshotJson(SESSION_ID, RUN_ID));
        assertNull(service.snapshotJson(SESSION_ID, " "));
    }

    private void stub(ContextEvent... events) {
        when(repository.findBySessionIdAndCorrelationIdAndEventTypeInOrderByCreatedAtAscIdAsc(eq(SESSION_ID), eq(RUN_ID), any()))
                .thenReturn(List.of(events));
    }

    private ContextEvent event(String type, Instant createdAt, String payload) {
        ContextEvent event = new ContextEvent(
                "session", "workspace", "user", type, 1L, payload);
        event.setId(UUID.randomUUID());
        event.setCorrelationId(RUN_ID);
        event.setCreatedAt(createdAt);
        return event;
    }
}
