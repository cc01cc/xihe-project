package com.cc01cc.p.xihe.cp.telemetry;

import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.springframework.http.ResponseEntity;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;

class TelemetryControllerTest {

    private static final com.fasterxml.jackson.databind.ObjectMapper MAPPER =
            new com.fasterxml.jackson.databind.ObjectMapper();

    @BeforeAll
    static void redirectTelemetryLog() throws Exception {
        Path dir = Files.createTempDirectory("telemetry-controller-test-");
        System.setProperty("XIHE_LOG_DIR", dir.toString());
    }

    private static TelemetryController controller(TelemetryRelayService relay) {
        return new TelemetryController("logs", relay, MAPPER);
    }

    private static TelemetryEntry.BatchRequest request(List<TelemetryEntry> entries) {
        TelemetryEntry.BatchRequest request = new TelemetryEntry.BatchRequest();
        request.setBatchId("b1");
        request.setDeviceId("dev");
        request.setEntries(entries);
        return request;
    }

    private static TelemetryEntry entry() {
        TelemetryEntry entry = new TelemetryEntry();
        entry.setTimestamp(System.currentTimeMillis());
        entry.setLevel("error");
        entry.setEventId("11111111-1111-4111-8111-111111111111");
        entry.setEventType("ui.unhandled_error");
        entry.setErrorCode("TypeError");
        return entry;
    }

    private static void assertProblem(ResponseEntity<?> response, String code) {
        assertEquals(400, response.getStatusCode().value());
        Object body = response.getBody();
        assertNotNull(body);
        assertEquals(code, ((Map<?, ?>) body).get("code"));
    }

    @Test
    void accepts_valid_structured_batch_writes_local_sink_and_forwards() throws Exception {
        TelemetryRelayService relay = mock(TelemetryRelayService.class);
        TelemetryEntry.BatchRequest batch = request(List.of(entry()));

        ResponseEntity<?> response = controller(relay).ingestAuth(batch);

        assertEquals(200, response.getStatusCode().value());
        assertEquals("ok", ((Map<?, ?>) response.getBody()).get("status"));
        verify(relay).forward(eq("b1"), eq(batch.getEntries()));
        Path log = Path.of(System.getProperty("XIHE_LOG_DIR"), "telemetry.log");
        assertTrue(Files.exists(log));
        String content = Files.readString(log);
        assertTrue(content.contains("ui.unhandled_error"));
        assertTrue(content.contains("TypeError"));
    }

    @Test
    void rejects_over_max_entries_without_writing_or_relaying() {
        TelemetryRelayService relay = mock(TelemetryRelayService.class);
        List<TelemetryEntry> entries = new ArrayList<>();
        for (int i = 0; i < TelemetryController.MAX_ENTRIES_PER_BATCH + 1; i++) {
            entries.add(entry());
        }

        ResponseEntity<?> response = controller(relay).ingestAuth(request(entries));

        assertProblem(response, "INVALID_REQUEST");
        verify(relay, never()).forward(any(), any());
    }

    @Test
    void rejects_oversized_message_and_invalid_event_type() {
        TelemetryRelayService relay = mock(TelemetryRelayService.class);
        TelemetryEntry longMessage = entry();
        longMessage.setMessage("x".repeat(TelemetryController.MAX_MESSAGE_LENGTH + 1));
        assertProblem(controller(relay).ingestAuth(request(List.of(longMessage))), "INVALID_REQUEST");

        TelemetryEntry badType = entry();
        badType.setEventType("Not A Type");
        assertProblem(controller(relay).ingestAuth(request(List.of(badType))), "INVALID_REQUEST");

        TelemetryEntry badLevel = entry();
        badLevel.setLevel("LOUD");
        assertProblem(controller(relay).ingestAuth(request(List.of(badLevel))), "INVALID_REQUEST");
    }

    @Test
    void empty_batch_stays_an_accepted_noop() {
        TelemetryRelayService relay = mock(TelemetryRelayService.class);
        TelemetryEntry.BatchRequest batch = request(new ArrayList<>());

        ResponseEntity<?> response = controller(relay).ingestAuth(batch);

        assertEquals(200, response.getStatusCode().value());
        verify(relay, never()).forward(any(), any());
    }
}
