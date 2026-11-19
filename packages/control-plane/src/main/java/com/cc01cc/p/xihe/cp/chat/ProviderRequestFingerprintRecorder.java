package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.entity.ChatRunProviderRequest;
import com.cc01cc.p.xihe.cp.repository.ChatRunProviderRequestRepository;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Instant;
import java.util.Base64;
import java.util.HexFormat;
import java.util.Map;
import java.util.UUID;

/**
 * PLAN-0679 T2.2 + task-103 (D-1869①): per-(run, provider step) persistence of the Agent's
 * six-layer provider-request record, including the verbatim wire bytes.
 *
 * <p><b>One row per dispatched step.</b> The Agent emits one {@code provider_request_fingerprint}
 * event per provider step, after the attempt. The write is idempotent on the natural key
 * {@code (run_id, provider_step)}: an SSE replay of the same step writes nothing, a re-dispatched
 * step lands as its own row, and the number of attempts is row count for the run.</p>
 *
 * <p><b>Verbatim (user ruling 2026-11-19, DEV-004 6.5b).</b> The audit block carries the exact
 * request / response / error bytes the sender saw, base64-encoded next to their sha256 and byte
 * count. Those bytes are stored as-is: no redaction, no rewriting, no normalisation. The sha256 is
 * recomputed from the decoded bytes before the write and a mismatch is logged, so the stored triple
 * is self-consistent by construction. {@code providerAudit=off} leaves the body columns NULL - never
 * 0, never an empty string - and {@code metadata} keeps sha/byte counts without bodies.</p>
 *
 * <p>Wire shape (Agent → CP): {@code {"document": {…six layers…}, "request": {…metadata…},
 * "audit": {…tier/status/timings/bodies…}}}. Best-effort, fail-open: a malformed payload or a write
 * failure is logged ({@code provider_fingerprint_dropped}) and never breaks the run's SSE stream.</p>
 */
@Component
public class ProviderRequestFingerprintRecorder {

    /** Event name published by the Agent ({@code provider_audit.PROVIDER_AUDIT_EVENT}). */
    public static final String EVENT_NAME = "provider_request_fingerprint";

    private static final Logger LOGGER = LoggerFactory.getLogger(ProviderRequestFingerprintRecorder.class);
    private static final String TIER_FULL = ChatRunProviderRequest.TIER_FULL;
    private static final String TIER_METADATA = ChatRunProviderRequest.TIER_METADATA;
    private static final String TIER_OFF = ChatRunProviderRequest.TIER_OFF;

    private final ChatRunProviderRequestRepository providerRequestRepository;
    private final ObjectMapper objectMapper;

    public ProviderRequestFingerprintRecorder(ChatRunProviderRequestRepository providerRequestRepository,
                                              ObjectMapper objectMapper) {
        this.providerRequestRepository = providerRequestRepository;
        this.objectMapper = objectMapper;
    }

    /**
     * Persist one provider step exactly once.
     *
     * @param payload the parsed event payload (envelope from the Agent, {@code runId} stamped by the
     *                relay); never null, may be malformed
     * @param runId   run identity from the relay's authorized context, never from the payload
     */
    public void recordFirstDispatch(Map<?, ?> payload, String runId) {
        try {
            UUID runUuid = UUID.fromString(runId);
            JsonNode documentNode = documentNode(payload);
            int providerStep = documentNode.path("providerStep").asInt(ChatRunProviderRequest.V1_PROVIDER_STEP);
            if (providerStep < 1) {
                throw new IllegalArgumentException("Invalid provider step " + providerStep);
            }
            Object rawRequest = payload.get("request");
            Map<?, ?> request = rawRequest instanceof Map<?, ?> map ? map : Map.of();
            Map<?, ?> audit = payload.get("audit") instanceof Map<?, ?> map ? map : Map.of();
            String tier = tierOf(audit);
            CapturedBytes requestBody = capturedBytes(audit.get("request"), tier);
            CapturedBytes responseBody = capturedBytes(audit.get("response"), tier);
            CapturedBytes errorBody = capturedBytes(audit.get("errorBody"), tier);
            int inserted = providerRequestRepository.insertStep(
                    runUuid,
                    providerStep,
                    documentNode.path("dispatchAttempt").asInt(ChatRunProviderRequest.V1_DISPATCH_ATTEMPT),
                    requiredString(request, "apiTypeId"),
                    optionalInt(request, "apiTypeVersion"),
                    requiredString(request, "model"),
                    requiredInt(request, "messageCount"),
                    requiredInt(request, "toolCount"),
                    requiredLong(request, "bytesTotal"),
                    jsonOf(request, "roleHistogram", "{}"),
                    jsonOf(request, "systemSources", "{}"),
                    documentNode.toString(),
                    Instant.now(),
                    tier,
                    optionalInt(audit, "httpStatus"),
                    optionalBoolean(audit, "streamed"),
                    optionalString(audit, "finishReason"),
                    optionalInt(audit, "ttftMs"),
                    optionalInt(audit, "totalMs"),
                    requestBody.sha256(),
                    requestBody.bytes(),
                    requestBody.body(),
                    responseBody.sha256(),
                    responseBody.bytes(),
                    responseBody.body(),
                    errorBody.sha256(),
                    errorBody.bytes(),
                    errorBody.body(),
                    optionalLong(audit, "cacheRead"),
                    optionalLong(audit, "cacheWrite"),
                    jsonOf(audit, "requestParams", null),
                    jsonOf(audit, "toolSurface", null),
                    audit.isEmpty() ? "{}" : objectMapper.valueToTree(audit).toString());
            if (inserted == 0) {
                LOGGER.debug("[LIFECYCLE] service=cp event=provider_fingerprint_write_skipped runId={}"
                        + " step={} document=already_recorded", runId, providerStep);
            }
        } catch (RuntimeException exception) {
            LOGGER.warn("[LIFECYCLE] service=cp event=provider_fingerprint_dropped runId={} reason={}",
                    runId, exception.getMessage());
        }
    }

    /**
     * A document is either a six-layer diagnostic (algo=sha256) or the Agent's fail-open error marker
     * {status,reasonCode}. The marker is stored too, so an oversized capture stays observable as
     * FINGERPRINT_TOO_LARGE instead of collapsing into not_captured.
     */
    private JsonNode documentNode(Map<?, ?> payload) {
        Object rawDocument = payload.get("document");
        if (!(rawDocument instanceof Map<?, ?> document)) {
            throw new IllegalArgumentException("Missing provider fingerprint document");
        }
        JsonNode documentNode = objectMapper.valueToTree(document);
        if (documentNode.hasNonNull("algo")) {
            if (!"sha256".equals(documentNode.path("algo").asText(""))) {
                throw new IllegalArgumentException(
                        "Unsupported provider fingerprint algo: " + documentNode.path("algo").asText(""));
            }
        } else if (!documentNode.hasNonNull("status")) {
            throw new IllegalArgumentException("Provider fingerprint document has no algo/status");
        }
        return documentNode;
    }

    /**
     * The audit tier decides what the durable record may keep. An absent block (older Agent) is read
     * as {@code metadata}: the six-layer document is complete, no bodies were recorded.
     */
    private static String tierOf(Map<?, ?> audit) {
        Object value = audit.get("tier");
        if (!(value instanceof String tier)) {
            return TIER_METADATA;
        }
        return switch (tier) {
            case TIER_FULL -> TIER_FULL;
            case TIER_OFF -> TIER_OFF;
            default -> TIER_METADATA;
        };
    }

    /**
     * Verbatim bytes of one captured side. The sha256 is recomputed from the decoded bytes, so the
     * stored (sha256, bytes, body) triple always describes the body that is actually in the column.
     */
    private CapturedBytes capturedBytes(Object rawBlock, String tier) {
        if (!(rawBlock instanceof Map<?, ?> block) || TIER_OFF.equals(tier)) {
            return CapturedBytes.NONE;
        }
        String declaredSha = optionalString(block, "sha256");
        Long declaredBytes = optionalLong(block, "bytes");
        Object rawBody = block.get("bodyB64");
        if (!TIER_FULL.equals(tier) || !(rawBody instanceof String encoded)) {
            return new CapturedBytes(declaredSha, declaredBytes, null);
        }
        byte[] body;
        try {
            body = Base64.getDecoder().decode(encoded);
        } catch (IllegalArgumentException exception) {
            return new CapturedBytes(null, declaredBytes, null);
        }
        String sha = sha256(body);
        if (declaredSha != null && !declaredSha.equalsIgnoreCase(sha)) {
            LOGGER.warn("[LIFECYCLE] service=cp event=provider_audit_sha_mismatch declared={} actual={}",
                    declaredSha, sha);
        }
        return new CapturedBytes(sha, (long) body.length, body);
    }

    private static String sha256(byte[] body) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(body));
        } catch (NoSuchAlgorithmException exception) {
            throw new IllegalStateException("SHA-256 unavailable", exception);
        }
    }

    private record CapturedBytes(String sha256, Long bytes, byte[] body) {
        static final CapturedBytes NONE = new CapturedBytes(null, null, null);
    }

    private static String requiredString(Map<?, ?> payload, String key) {
        Object value = payload.get(key);
        if (!(value instanceof String string) || string.isBlank()) {
            throw new IllegalArgumentException("Missing provider fingerprint field " + key);
        }
        return string;
    }

    private static String optionalString(Map<?, ?> payload, String key) {
        Object value = payload.get(key);
        return value instanceof String string && !string.isBlank() ? string : null;
    }

    private static Integer optionalInt(Map<?, ?> payload, String key) {
        Object value = payload.get(key);
        return value instanceof Number number ? number.intValue() : null;
    }

    private static Long optionalLong(Map<?, ?> payload, String key) {
        Object value = payload.get(key);
        return value instanceof Number number ? number.longValue() : null;
    }

    private static Boolean optionalBoolean(Map<?, ?> payload, String key) {
        Object value = payload.get(key);
        return value instanceof Boolean bool ? bool : null;
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

    /** Metadata maps are stored as-is; absent keeps {@code fallback} (never a fake value). */
    private String jsonOf(Map<?, ?> payload, String key, String fallback) {
        Object value = payload.get(key);
        if (!(value instanceof Map<?, ?> map) || map.isEmpty()) {
            return fallback;
        }
        return objectMapper.valueToTree(map).toString();
    }
}