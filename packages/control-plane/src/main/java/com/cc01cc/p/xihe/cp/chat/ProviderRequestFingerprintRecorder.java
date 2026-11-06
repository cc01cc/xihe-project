package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.repository.ChatRunProviderRequestRepository;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import java.time.Instant;
import java.util.Map;
import java.util.UUID;

/**
 * PLAN-0679 T2.2 (design D1/D2/D5): write-once persistence of the Agent's six-layer
 * provider-request fingerprint for a run.
 *
 * <p>The Agent emits one {@code provider_request_fingerprint} event per run (first provider step
 * only). A context-overflow re-dispatch re-enters the first provider step and can emit a second
 * event for the same run, so the write-once guard lives in SQL
 * ({@code ON CONFLICT (run_id) DO NOTHING}): the first document wins, matching PLAN-0666 D3.</p>
 *
 * <p>Wire shape (Agent → CP, design D4/D5): {@code {"document": {…six layers…}, "request": {…run
 * metadata…}}}. The document is stored verbatim in {@code fingerprint}; the request block carries
 * the facts only the Agent knows about the final rendered body (api type, resolved model, counts,
 * role histogram, slot fill state). Both are hash/count/byte/metadata only — never prompt content,
 * so the whole payload is safe to persist (D5).</p>
 *
 * <p>Best-effort, fail-open: a malformed payload or a write failure is logged
 * ({@code provider_fingerprint_dropped}) and never breaks the run's SSE stream (D4).</p>
 */
@Component
public class ProviderRequestFingerprintRecorder {

    /** Event name published by the Agent ({@code provider_fingerprint.PROVIDER_FINGERPRINT_EVENT}). */
    public static final String EVENT_NAME = "provider_request_fingerprint";

    private static final Logger LOGGER = LoggerFactory.getLogger(ProviderRequestFingerprintRecorder.class);

    private final ChatRunProviderRequestRepository providerRequestRepository;
    private final ObjectMapper objectMapper;

    public ProviderRequestFingerprintRecorder(ChatRunProviderRequestRepository providerRequestRepository,
                                              ObjectMapper objectMapper) {
        this.providerRequestRepository = providerRequestRepository;
        this.objectMapper = objectMapper;
    }

    /**
     * Persist the first dispatch's fingerprint exactly once.
     *
     * @param payload the parsed event payload (envelope from the Agent, {@code runId} stamped by the
     *                relay); never null, may be malformed
     * @param runId   run identity from the relay's authorized context, never from the payload
     */
    public void recordFirstDispatch(Map<?, ?> payload, String runId) {
        try {
            UUID runUuid = UUID.fromString(runId);
            Object rawDocument = payload.get("document");
            if (!(rawDocument instanceof Map<?, ?> document)) {
                throw new IllegalArgumentException("Missing provider fingerprint document");
            }
            JsonNode documentNode = objectMapper.valueToTree(document);
            // A document is either a six-layer diagnostic (algo=sha256) or the Agent's fail-open
            // error marker {status,reasonCode} — the latter is stored too, so an oversized capture
            // stays observable as FINGERPRINT_TOO_LARGE instead of collapsing into not_captured.
            if (documentNode.hasNonNull("algo")) {
                if (!"sha256".equals(documentNode.path("algo").asText(""))) {
                    throw new IllegalArgumentException(
                            "Unsupported provider fingerprint algo: " + documentNode.path("algo").asText(""));
                }
            } else if (!documentNode.hasNonNull("status")) {
                throw new IllegalArgumentException("Provider fingerprint document has no algo/status");
            }
            int providerStep = documentNode.path("providerStep").asInt(1);
            if (providerStep != 1) {
                LOGGER.debug("[LIFECYCLE] service=cp event=provider_fingerprint_skipped runId={} step={}",
                        runId, providerStep);
                return;
            }
            Object rawRequest = payload.get("request");
            Map<?, ?> request = rawRequest instanceof Map<?, ?> map ? map : Map.of();
            int inserted = providerRequestRepository.insertOnce(
                    runUuid,
                    documentNode.path("dispatchAttempt").asInt(1),
                    providerStep,
                    requiredString(request, "apiTypeId"),
                    optionalInt(request, "apiTypeVersion"),
                    requiredString(request, "model"),
                    requiredInt(request, "messageCount"),
                    requiredInt(request, "toolCount"),
                    requiredLong(request, "bytesTotal"),
                    jsonOf(request, "roleHistogram"),
                    jsonOf(request, "systemSources"),
                    documentNode.toString(),
                    Instant.now());
            if (inserted == 0) {
                LOGGER.debug("[LIFECYCLE] service=cp event=provider_fingerprint_write_skipped runId={}"
                        + " document=already_recorded", runId);
            }
        } catch (RuntimeException exception) {
            LOGGER.warn("[LIFECYCLE] service=cp event=provider_fingerprint_dropped runId={} reason={}",
                    runId, exception.getMessage());
        }
    }

    private static String requiredString(Map<?, ?> payload, String key) {
        Object value = payload.get(key);
        if (!(value instanceof String string) || string.isBlank()) {
            throw new IllegalArgumentException("Missing provider fingerprint field " + key);
        }
        return string;
    }

    private static Integer optionalInt(Map<?, ?> payload, String key) {
        Object value = payload.get(key);
        return value instanceof Number number ? number.intValue() : null;
    }

    private static int requiredInt(Map<?, ?> payload, String key) {
        Object value = payload.get(key);
        if (!(value instanceof Number number)) {
            throw new IllegalArgumentException("Missing provider fingerprint field " + key);
        }
        return number.intValue();
    }

    private static long requiredLong(Map<?, ?> payload, String key) {
        Object value = payload.get(key);
        if (!(value instanceof Number number)) {
            throw new IllegalArgumentException("Missing provider fingerprint field " + key);
        }
        return number.longValue();
    }

    /** Metadata maps are stored as-is; absent keeps the column default {@code {}} (never a fake value). */
    private String jsonOf(Map<?, ?> payload, String key) {
        Object value = payload.get(key);
        if (!(value instanceof Map<?, ?> map) || map.isEmpty()) {
            return "{}";
        }
        return objectMapper.valueToTree(map).toString();
    }
}
