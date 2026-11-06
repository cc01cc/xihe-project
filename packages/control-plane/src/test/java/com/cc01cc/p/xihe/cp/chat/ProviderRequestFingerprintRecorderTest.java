package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.repository.ChatRunProviderRequestRepository;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;

import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * PLAN-0679 T2.2: the write-once recorder is fail-open by contract (design D4/D5).
 *
 * <p>These tests pin the two things a relay branch must never get wrong: the persisted row carries
 * exactly the metadata the Agent measured (no prompt content, no re-derivation), and no malformed /
 * duplicate / failing payload can escape as an exception (the run's SSE stream keeps going).</p>
 */
class ProviderRequestFingerprintRecorderTest {

    private static final String RUN = "00000000-0000-4000-8000-000000000001";
    private static final UUID RUN_UUID = UUID.fromString(RUN);

    private final ChatRunProviderRequestRepository repository =
            mock(ChatRunProviderRequestRepository.class);
    private final ObjectMapper objectMapper = new ObjectMapper();
    private final ProviderRequestFingerprintRecorder recorder =
            new ProviderRequestFingerprintRecorder(repository, objectMapper);

    private static Map<String, Object> request() {
        Map<String, Object> request = new LinkedHashMap<>();
        request.put("apiTypeId", "openai-chat-completions");
        request.put("apiTypeVersion", 1);
        request.put("model", "openai/gpt-5");
        request.put("messageCount", 5);
        request.put("toolCount", 3);
        request.put("bytesTotal", 22340);
        request.put("roleHistogram", Map.of("user", 2, "assistant", 3));
        request.put("systemSources", Map.of("slots", Map.of("user_input", true)));
        return request;
    }

    private static Map<String, Object> document() {
        Map<String, Object> layers = new LinkedHashMap<>();
        layers.put("systemTemplate", Map.of("hash", "a", "bytes", 100));
        layers.put("userInput", Map.of("hash", "b", "bytes", 40));
        Map<String, Object> document = new LinkedHashMap<>();
        document.put("algo", "sha256");
        document.put("dispatchAttempt", 1);
        document.put("providerStep", 1);
        document.put("layers", layers);
        document.put("outbound", Map.of("hash", "c", "bytes", 22340));
        return document;
    }

    private static Map<String, Object> payload(Object document, Object request) {
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("runId", RUN);
        payload.put("document", document);
        payload.put("request", request);
        return payload;
    }

    @Test
    void validPayloadIsPersistedWithTheAgentMeasuredMetadata() {
        when(repository.insertOnce(any(), anyInt(), anyInt(), anyString(), any(), anyString(),
                anyInt(), anyInt(), anyLong(), anyString(), anyString(), anyString(), any()))
                .thenReturn(1);

        recorder.recordFirstDispatch(payload(document(), request()), RUN);

        verify(repository).insertOnce(
                eq(RUN_UUID), eq(1), eq(1), eq("openai-chat-completions"), eq(1), eq("openai/gpt-5"),
                eq(5), eq(3), eq(22340L), anyString(), anyString(), anyString(), any(Instant.class));

        ArgumentCaptor<String> fingerprints = ArgumentCaptor.forClass(String.class);
        verify(repository).insertOnce(any(), anyInt(), anyInt(), anyString(), any(), anyString(),
                anyInt(), anyInt(), anyLong(), anyString(), anyString(), fingerprints.capture(),
                any());
        JsonNode stored = readJson(fingerprints.getValue());
        assertThat(stored.path("algo").asText()).isEqualTo("sha256");
        assertThat(stored.path("layers").path("userInput").path("hash").asText()).isEqualTo("b");
        // Metadata maps are persisted as JSON objects, not stringified Scala-escaped blobs.
        ArgumentCaptor<String> histograms = ArgumentCaptor.forClass(String.class);
        verify(repository).insertOnce(any(), anyInt(), anyInt(), anyString(), any(), anyString(),
                anyInt(), anyInt(), anyLong(), histograms.capture(), anyString(), anyString(), any());
        assertThat(readJson(histograms.getValue()).path("assistant").asInt()).isEqualTo(3);
    }

    @Test
    void duplicateInsertIsANoOpNotAnError() {
        when(repository.insertOnce(any(), anyInt(), anyInt(), anyString(), any(), anyString(),
                anyInt(), anyInt(), anyLong(), anyString(), anyString(), anyString(), any()))
                .thenReturn(0);

        recorder.recordFirstDispatch(payload(document(), request()), RUN);

        verify(repository).insertOnce(any(), anyInt(), anyInt(), anyString(), any(), anyString(),
                anyInt(), anyInt(), anyLong(), anyString(), anyString(), anyString(), any());
    }

    @Test
    void missingDocumentIsDroppedWithoutTouchingTheRepository() {
        recorder.recordFirstDispatch(payload(null, request()), RUN);
        verify(repository, never()).insertOnce(any(), anyInt(), anyInt(), anyString(), any(),
                anyString(), anyInt(), anyInt(), anyLong(), anyString(), anyString(), anyString(),
                any());
    }

    @Test
    void malformedRunIdIsDroppedWithoutThrowing() {
        recorder.recordFirstDispatch(payload(document(), request()), "not-a-uuid");
        verify(repository, never()).insertOnce(any(), anyInt(), anyInt(), anyString(), any(),
                anyString(), anyInt(), anyInt(), anyLong(), anyString(), anyString(), anyString(),
                any());
    }

    @Test
    void unsupportedAlgorithmIsDropped() {
        Map<String, Object> document = document();
        document.put("algo", "sha1");
        recorder.recordFirstDispatch(payload(document, request()), RUN);
        verify(repository, never()).insertOnce(any(), anyInt(), anyInt(), anyString(), any(),
                anyString(), anyInt(), anyInt(), anyLong(), anyString(), anyString(), anyString(),
                any());
    }

    @Test
    void nonFirstStepIsSkipped() {
        Map<String, Object> document = document();
        document.put("providerStep", 2);
        recorder.recordFirstDispatch(payload(document, request()), RUN);
        verify(repository, never()).insertOnce(any(), anyInt(), anyInt(), anyString(), any(),
                anyString(), anyInt(), anyInt(), anyLong(), anyString(), anyString(), anyString(),
                any());
    }

    @Test
    void failOpenErrorMarkerIsStillStoredSoTheReadSideCanNameIt() {
        when(repository.insertOnce(any(), anyInt(), anyInt(), anyString(), any(), anyString(),
                anyInt(), anyInt(), anyLong(), anyString(), anyString(), anyString(), any()))
                .thenReturn(1);
        Map<String, Object> marker = Map.of("status", "error", "reasonCode", "FINGERPRINT_TOO_LARGE");

        recorder.recordFirstDispatch(payload(marker, request()), RUN);

        verify(repository).insertOnce(eq(RUN_UUID), eq(1), eq(1), anyString(), any(), anyString(),
                anyInt(), anyInt(), anyLong(), anyString(), anyString(), anyString(), any());
    }

    @Test
    void repositoryFailureNeverEscapes() {
        when(repository.insertOnce(any(), anyInt(), anyInt(), anyString(), any(), anyString(),
                anyInt(), anyInt(), anyLong(), anyString(), anyString(), anyString(), any()))
                .thenThrow(new IllegalStateException("database is down"));

        recorder.recordFirstDispatch(payload(document(), request()), RUN);
    }

    @Test
    void missingRequestBlockKeepsTheWriteButFailsOpenOnRequiredFields() {
        // A document without the request block cannot satisfy the NOT NULL metadata columns, so the
        // row is dropped instead of being written with invented values.
        recorder.recordFirstDispatch(payload(document(), null), RUN);
        verify(repository, never()).insertOnce(any(), anyInt(), anyInt(), anyString(), any(),
                anyString(), anyInt(), anyInt(), anyLong(), anyString(), anyString(), anyString(),
                any());
    }

    private JsonNode readJson(String value) {
        try {
            return objectMapper.readTree(value);
        } catch (Exception exception) {
            throw new AssertionError("not JSON: " + value, exception);
        }
    }
}
