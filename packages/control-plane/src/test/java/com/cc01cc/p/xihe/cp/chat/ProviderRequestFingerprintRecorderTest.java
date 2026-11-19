package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.repository.ChatRunProviderRequestRepository;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Base64;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.mockingDetails;

/**
 * PLAN-0679 T2.2 + task-103 (D-1869①): the per-step recorder is fail-open by contract (design D4/D5)
 * and, since the 2026-11-19 ruling (DEV-004 6.5b), stores the provider body bytes verbatim.
 *
 * <p>The three counter-examples from the card are pinned here: (1) a body carrying an
 * {@code Authorization: Bearer}/{@code sk-} credential is stored byte-identical with a matching
 * sha256 and no {@code ***} rewriting; (2) {@code providerAudit=off} leaves the body columns NULL
 * (never 0, never empty); (3) a re-dispatched step lands on its own {@code provider_step} row instead
 * of being dropped or colliding with step 1.</p>
 */
class ProviderRequestFingerprintRecorderTest {

    private static final String RUN = "00000000-0000-4000-8000-000000000001";
    private static final UUID RUN_UUID = UUID.fromString(RUN);

    private final ChatRunProviderRequestRepository repository =
            mock(ChatRunProviderRequestRepository.class);
    private final ObjectMapper objectMapper = new ObjectMapper();
    private final ProviderRequestFingerprintRecorder recorder =
            new ProviderRequestFingerprintRecorder(repository, objectMapper);

    private List<Object> lastArgs = List.of();

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

    private static Map<String, Object> withAudit(Map<String, Object> payload, Map<String, Object> audit) {
        payload.put("audit", audit);
        return payload;
    }

    private static Map<String, Object> bodyBlock(byte[] body) {
        Map<String, Object> block = new LinkedHashMap<>();
        block.put("sha256", sha256(body));
        block.put("bytes", body.length);
        block.put("bodyB64", Base64.getEncoder().encodeToString(body));
        return block;
    }

    private static Map<String, Object> audit(String tier) {
        Map<String, Object> audit = new LinkedHashMap<>();
        audit.put("tier", tier);
        audit.put("httpStatus", 200);
        audit.put("streamed", true);
        audit.put("ttftMs", 5);
        audit.put("totalMs", 12);
        return audit;
    }

    private static String sha256(byte[] body) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(body));
        } catch (Exception exception) {
            throw new AssertionError(exception);
        }
    }

    /** Capture the single insertStep call without restating its 33 arguments in every test. */
    private void stubInsert() {
        doAnswer(invocation -> {
            // Arrays.asList (not List.of): captured arguments legitimately contain nulls.
            lastArgs = java.util.Arrays.asList(invocation.getArguments());
            return 1;
        }).when(repository).insertStep(any(), anyInt(), anyInt(), anyString(), any(), anyString(),
                anyInt(), anyInt(), anyLong(), anyString(), anyString(), anyString(), any(), anyString(),
                any(), any(), any(), any(), any(), any(), any(), any(), any(), any(), any(), any(), any(),
                any(), any(), any(), any(), any(), any());
    }

    private void assertNoInsert() {
        assertThat(mockingDetails(repository).getInvocations()).isEmpty();
    }

    private void record(Map<String, Object> payload) {
        recorder.recordFirstDispatch(payload, RUN);
    }

    @Test
    void validPayloadIsPersistedWithTheAgentMeasuredMetadata() {
        stubInsert();

        record(payload(document(), request()));

        assertThat(lastArgs.get(0)).isEqualTo(RUN_UUID);
        assertThat(lastArgs.get(1)).isEqualTo(1);
        assertThat(lastArgs.get(2)).isEqualTo(1);
        assertThat(lastArgs.get(3)).isEqualTo("openai-chat-completions");
        assertThat(lastArgs.get(4)).isEqualTo(1);
        assertThat(lastArgs.get(5)).isEqualTo("openai/gpt-5");
        assertThat(lastArgs.get(6)).isEqualTo(5);
        assertThat(lastArgs.get(7)).isEqualTo(3);
        assertThat(lastArgs.get(8)).isEqualTo(22340L);
        // Metadata maps are persisted as JSON objects, not stringified Scala-escaped blobs.
        JsonNode histogram = readJson((String) lastArgs.get(9));
        assertThat(histogram.path("assistant").asInt()).isEqualTo(3);
        JsonNode stored = readJson((String) lastArgs.get(11));
        assertThat(stored.path("algo").asText()).isEqualTo("sha256");
        assertThat(stored.path("layers").path("userInput").path("hash").asText()).isEqualTo("b");
    }

    @Test
    void payloadWithoutAuditShowsAsMetadataTierAndNoBodies() {
        stubInsert();

        record(payload(document(), request()));

        // An older Agent ships no audit block: the six-layer document is complete, no body was
        // recorded. Claiming 'full' would be a lie about a body that does not exist.
        assertThat(lastArgs.get(13)).isEqualTo("metadata");
        assertThat(lastArgs.get(21)).isNull();
        assertThat(lastArgs.get(18)).isNull();
    }

    @Test
    void verbatimRequestBytesAreStoredUnchangedWithMatchingSha() {
        stubInsert();
        byte[] wire = ("{\"messages\":[{\"role\":\"user\",\"content\":\"hello\"}],"
                + "\"headers\":{\"Authorization\":\"Bearer sk-live-123\"}}").getBytes(StandardCharsets.UTF_8);
        Map<String, Object> audit = audit("full");
        audit.put("request", bodyBlock(wire));

        record(withAudit(payload(document(), request()), audit));

        byte[] stored = (byte[]) lastArgs.get(21);
        assertThat(stored).isEqualTo(wire);
        assertThat(lastArgs.get(19)).isEqualTo(sha256(wire));
        assertThat(lastArgs.get(20)).isEqualTo((long) wire.length);
        String verbatim = new String(stored, StandardCharsets.UTF_8);
        assertThat(verbatim).contains("Bearer sk-live-123");
        assertThat(verbatim).doesNotContain("***");
        assertThat(lastArgs.get(13)).isEqualTo("full");
    }

    @Test
    void offTierLeavesEveryBodyColumnNull() {
        stubInsert();
        Map<String, Object> audit = audit("off");
        audit.put("request", bodyBlock("should-not-be-stored".getBytes(StandardCharsets.UTF_8)));
        audit.put("response", bodyBlock("{}".getBytes(StandardCharsets.UTF_8)));

        record(withAudit(payload(document(), request()), audit));

        assertThat(lastArgs.get(13)).isEqualTo("off");
        assertThat(lastArgs.get(19)).isNull();
        assertThat(lastArgs.get(20)).isNull();
        assertThat(lastArgs.get(21)).isNull();
        assertThat(lastArgs.get(22)).isNull();
        assertThat(lastArgs.get(24)).isNull();
        assertThat(lastArgs.get(30)).isNull();
        assertThat(lastArgs.get(31)).isNull();
    }

    @Test
    void metadataTierKeepsShaAndByteCountWithoutBodies() {
        stubInsert();
        byte[] wire = "{}".getBytes(StandardCharsets.UTF_8);
        Map<String, Object> audit = audit("metadata");
        audit.put("request", bodyBlock(wire));

        record(withAudit(payload(document(), request()), audit));

        assertThat(lastArgs.get(19)).isEqualTo(sha256(wire));
        assertThat(lastArgs.get(20)).isEqualTo((long) wire.length);
        assertThat(lastArgs.get(21)).isNull();
    }

    @Test
    void responseErrorBodiesAndCacheCountersTravelWithTheStep() {
        stubInsert();
        byte[] response = "data: {\"choices\":[]}\n\n".getBytes(StandardCharsets.UTF_8);
        byte[] error = "{\"error\":\"rate\"}".getBytes(StandardCharsets.UTF_8);
        Map<String, Object> audit = audit("full");
        audit.put("response", bodyBlock(response));
        audit.put("errorBody", bodyBlock(error));
        audit.put("httpStatus", 429);
        audit.put("finishReason", "length");
        audit.put("cacheRead", 7);
        audit.put("cacheWrite", 3);
        audit.put("requestParams", Map.of("model", "openai/gpt-5", "stream", true));
        audit.put("toolSurface", Map.of("sha256", "e", "count", 3));

        record(withAudit(payload(document(), request()), audit));

        assertThat((byte[]) lastArgs.get(24)).isEqualTo(response);
        assertThat(lastArgs.get(22)).isEqualTo(sha256(response));
        assertThat((byte[]) lastArgs.get(27)).isEqualTo(error);
        assertThat(lastArgs.get(14)).isEqualTo(429);
        assertThat(lastArgs.get(16)).isEqualTo("length");
        assertThat(lastArgs.get(28)).isEqualTo(7L);
        assertThat(lastArgs.get(29)).isEqualTo(3L);
        JsonNode params = readJson((String) lastArgs.get(30));
        assertThat(params.path("model").asText()).isEqualTo("openai/gpt-5");
        JsonNode surface = readJson((String) lastArgs.get(31));
        assertThat(surface.path("count").asInt()).isEqualTo(3);
    }

    @Test
    void missingCacheCountersStayNullInsteadOfBecomingZero() {
        stubInsert();
        // A provider that reports no cache counters must not be stored as "0 tokens cached":
        // 0 would claim a measured miss and would poison any average over the column.
        record(withAudit(payload(document(), request()), audit("full")));

        assertThat(lastArgs.get(28)).isNull();
        assertThat(lastArgs.get(29)).isNull();
    }

    @Test
    void reDispatchedStepLandsOnItsOwnRowInsteadOfBeingSkipped() {
        stubInsert();
        Map<String, Object> second = document();
        second.put("providerStep", 2);
        Map<String, Object> audit = audit("full");
        audit.put("request", bodyBlock("second".getBytes(StandardCharsets.UTF_8)));

        record(withAudit(payload(second, request()), audit));

        assertThat(lastArgs.get(1)).isEqualTo(2);
        assertThat(lastArgs.get(21)).isEqualTo("second".getBytes(StandardCharsets.UTF_8));
    }

    @Test
    void misdeclaredShaIsRecomputedFromTheStoredBytes() {
        stubInsert();
        byte[] wire = "{\"a\":1}".getBytes(StandardCharsets.UTF_8);
        Map<String, Object> block = new LinkedHashMap<>();
        block.put("sha256", "deadbeef");
        block.put("bytes", wire.length);
        block.put("bodyB64", Base64.getEncoder().encodeToString(wire));
        Map<String, Object> audit = audit("full");
        audit.put("request", block);

        record(withAudit(payload(document(), request()), audit));

        // The stored triple must describe the bytes that are actually in the column.
        assertThat(lastArgs.get(19)).isEqualTo(sha256(wire));
    }

    @Test
    void duplicateInsertIsANoOpNotAnError() {
        doAnswer(invocation -> 0).when(repository).insertStep(any(), anyInt(), anyInt(), anyString(),
                any(), anyString(), anyInt(), anyInt(), anyLong(), anyString(), anyString(), anyString(),
                any(), anyString(), any(), any(), any(), any(), any(), any(), any(), any(), any(), any(),
                any(), any(), any(), any(), any(), any(), any(), any(), any());

        record(payload(document(), request()));

        assertThat(mockingDetails(repository).getInvocations()).hasSize(1);
    }

    @Test
    void missingDocumentIsDroppedWithoutTouchingTheRepository() {
        record(payload(null, request()));
        assertNoInsert();
    }

    @Test
    void malformedRunIdIsDroppedWithoutThrowing() {
        recorder.recordFirstDispatch(payload(document(), request()), "not-a-uuid");
        assertNoInsert();
    }

    @Test
    void unsupportedAlgorithmIsDropped() {
        Map<String, Object> document = document();
        document.put("algo", "sha1");
        record(payload(document, request()));
        assertNoInsert();
    }

    @Test
    void failOpenErrorMarkerIsStillStoredSoTheReadSideCanNameIt() {
        stubInsert();
        Map<String, Object> marker = Map.of("status", "error", "reasonCode", "FINGERPRINT_TOO_LARGE");

        record(payload(marker, request()));

        assertThat(lastArgs.get(0)).isEqualTo(RUN_UUID);
        assertThat(lastArgs.get(1)).isEqualTo(1);
    }

    @Test
    void repositoryFailureNeverEscapes() {
        doThrow(new IllegalStateException("database is down")).when(repository).insertStep(any(), anyInt(),
                anyInt(), anyString(), any(), anyString(), anyInt(), anyInt(), anyLong(), anyString(),
                anyString(), anyString(), any(), anyString(), any(), any(), any(), any(), any(), any(), any(),
                any(), any(), any(), any(), any(), any(), any(), any(), any(), any(), any(), any());

        record(payload(document(), request()));

        assertThat(mockingDetails(repository).getInvocations()).hasSize(1);
    }

    @Test
    void missingRequestBlockKeepsTheWriteButFailsOpenOnRequiredFields() {
        // A document without the request block cannot satisfy the NOT NULL metadata columns, so the
        // row is dropped instead of being written with invented values.
        record(payload(document(), null));
        assertNoInsert();
    }

    private JsonNode readJson(String value) {
        try {
            return objectMapper.readTree(value);
        } catch (Exception exception) {
            throw new AssertionError("not JSON: " + value, exception);
        }
    }
}