package com.cc01cc.p.xihe.cp.chat;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.cc01cc.p.xihe.cp.config.ConfigService;
import com.cc01cc.p.xihe.cp.context.service.ContextProjectionService;
import com.cc01cc.p.xihe.cp.repository.ChatRunRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * PLAN-0666 M1b: writes the per-run context fingerprint at the first dispatch.
 *
 * <p><b>Failure policy (D5, fail-open):</b> nothing here may fail the run. Any exception is logged
 * (redacted), the document is re-attempted as {@code {"status":"error","reasonCode":"HASH_FAILED"}},
 * and dispatch continues. A fingerprint is an observability artifact, never a precondition.
 *
 * <p><b>Write-once (D3 / design §2.2):</b> the UPDATE is guarded by {@code context_fingerprint IS
 * NULL}, so a context-overflow re-dispatch cannot replace the first document. v1 records the first
 * dispatch only; attempt-level fingerprints are v2.
 */
@Component
public class ContextFingerprintRecorder {

    private static final Logger log = LoggerFactory.getLogger(ContextFingerprintRecorder.class);

    private static final String CONTEXT_POLICY_DOMAIN = "context-policy";
    private static final String FINGERPRINT_FLAG = "fingerprintEnabled";

    private final ChatRunRepository chatRunRepository;
    private final ContextProjectionService projectionService;
    private final ConfigService configService;
    private final ObjectMapper objectMapper;

    public ContextFingerprintRecorder(ChatRunRepository chatRunRepository,
                                      ContextProjectionService projectionService,
                                      ConfigService configService,
                                      ObjectMapper objectMapper) {
        this.chatRunRepository = chatRunRepository;
        this.projectionService = projectionService;
        this.configService = configService;
        this.objectMapper = objectMapper;
    }

    /** Dispatch-side inputs; every layer the control plane can see is passed explicitly. */
    public record RecordInput(String runId,
                              String sessionId,
                              String branchId,
                              String userId,
                              String workspaceId,
                              JsonNode templateSnapshot,
                              JsonNode skillsSnapshot,
                              String content,
                              Map<String, Object> componentSources,
                              String instructions,
                              Map<String, Map<String, String>> userOverrides,
                              Map<String, Map<String, String>> workspaceOverrides,
                              Map<String, Object> outbound) {}

    /**
     * Record the fingerprint for the run's first dispatch. Never throws: see the failure policy.
     * Safe to call more than once (the SQL update is write-once).
     */
    public void recordFirstDispatch(RecordInput input) {
        if (input == null || input.runId() == null || input.runId().isBlank()) {
            log.warn("[CONTEXT-FINGERPRINT] event=record_skipped reason=no_run_id");
            return;
        }
        try {
            ObjectNode document = workspaceEnabled(input.userId(), input.workspaceId())
                    ? buildDocument(input)
                    : ContextFingerprintCalculator.disabled();
            write(input.runId(), document);
        } catch (RuntimeException exception) {
            log.warn("[CONTEXT-FINGERPRINT] event=collect_failed runId={} reason={}",
                    input.runId(), exception.getClass().getSimpleName(), exception);
            write(input.runId(), ContextFingerprintCalculator.error("HASH_FAILED"));
        }
    }

    /**
     * BL-285 follow-up (2026-11-05): every layer payload goes through
     * {@link FingerprintPayloadNormalizer} before hashing —
     * volatile fields ({@code capturedAt} and friends) are stripped, and the {@code memory} layer is
     * narrowed to the memory/tree component sources so a skills change cannot pollute it. The stored
     * snapshots are untouched; only the hashed payload is normalized.
     *
     * <p>Package-private so the determinism test can build the document without a database.</p>
     */
    ObjectNode buildDocument(RecordInput input) {
        Map<String, Object> layers = new LinkedHashMap<>();
        layers.put("template", FingerprintPayloadNormalizer.normalize(input.templateSnapshot()));
        layers.put("skills", FingerprintPayloadNormalizer.normalize(input.skillsSnapshot()));
        layers.put("history", FingerprintPayloadNormalizer.normalize(
                historyLayer(input.sessionId(), input.branchId())));
        layers.put("memory", FingerprintPayloadNormalizer.memorySources(
                input.componentSources(), input.templateSnapshot()));
        layers.put("userInput", Map.of("content", input.content() == null ? "" : input.content()));
        layers.put("attachments", FingerprintPayloadNormalizer.normalize(attachments(input.outbound())));
        layers.put("config", FingerprintPayloadNormalizer.normalize(configLayer(input)));
        layers.put("tools", new ContextFingerprintCalculator.Unavailable("agent_side"));
        return ContextFingerprintCalculator.calculate(layers, outboundForHash(input.outbound()), 1);
    }

    /**
     * History = the stored projection's messages *before* this turn (the Agent appends the prompt).
     * A single unreadable layer must not blank the whole fingerprint: it is reported as
     * {@code unavailable} while the remaining layers stay usable.
     */
    private Object historyLayer(String sessionId, String branchId) {
        try {
            return projectionService.currentHistoryMessages(sessionId, branchId);
        } catch (RuntimeException exception) {
            log.warn("[CONTEXT-FINGERPRINT] event=history_unreadable reason={}",
                    exception.getClass().getSimpleName());
            return new ContextFingerprintCalculator.Unavailable("history_unreadable");
        }
    }

    /** History = the stored projection's messages *before* this turn (the Agent appends the prompt). */
    private JsonNode historyMessages(String sessionId, String branchId) {
        return projectionService.currentHistoryMessages(sessionId, branchId);
    }

    private static Map<String, Object> attachments(Map<String, Object> outbound) {
        Map<String, Object> attachments = new LinkedHashMap<>();
        for (String key : List.of("images", "attachments", "pathMentions")) {
            if (outbound != null && outbound.containsKey(key)) {
                attachments.put(key, outbound.get(key));
            }
        }
        return attachments;
    }

    private static Map<String, Object> configLayer(RecordInput input) {
        Map<String, Object> config = new LinkedHashMap<>();
        if (input.instructions() != null) {
            config.put("instructions", input.instructions());
        }
        if (input.userOverrides() != null && !input.userOverrides().isEmpty()) {
            config.put("userOverrides", input.userOverrides());
        }
        if (input.workspaceOverrides() != null && !input.workspaceOverrides().isEmpty()) {
            config.put("workspaceOverrides", input.workspaceOverrides());
        }
        return config;
    }

    /**
     * Copy without the per-dispatch volatile fields (token/run id/request id/timestamps) before
     * hashing. Delegates to the shared normalizer so the outbound hash and the layer payloads cannot
     * drift apart in what they consider volatile.
     */
    @SuppressWarnings("unchecked")
    private static Map<String, Object> outboundForHash(Map<String, Object> outbound) {
        if (outbound == null) {
            return null;
        }
        return (Map<String, Object>) FingerprintPayloadNormalizer.normalize(outbound);
    }

    /**
     * D5 workspace switch: {@code context-policy.defaults.fingerprintEnabled}, default true.
     * A broken config read must not disable observability silently, so it defaults to enabled.
     */
    private boolean workspaceEnabled(String userId, String workspaceId) {
        try {
            Map<String, String> domain = configService.resolveDomain(
                    CONTEXT_POLICY_DOMAIN, uuidOrNull(userId), uuidOrNull(workspaceId));
            if (domain == null) {
                return true;
            }
            String defaults = domain.get("defaults");
            if (defaults == null || defaults.isBlank()) {
                return true;
            }
            JsonNode flag = objectMapper.readTree(defaults).path(FINGERPRINT_FLAG);
            return !flag.isBoolean() || flag.asBoolean();
        } catch (RuntimeException | JsonProcessingException exception) {
            log.warn("[CONTEXT-FINGERPRINT] event=config_read_failed default=enabled reason={}",
                    exception.getClass().getSimpleName());
            return true;
        }
    }

    private void write(String runId, ObjectNode document) {
        try {
            UUID runUuid = UUID.fromString(runId);
            int updated = chatRunRepository.recordContextFingerprint(runUuid, document.toString());
            if (updated == 0) {
                log.debug("[CONTEXT-FINGERPRINT] event=write_skipped runId={} reason=already_recorded", runId);
            }
        } catch (RuntimeException exception) {
            log.warn("[CONTEXT-FINGERPRINT] event=write_failed runId={} reason={}",
                    runId, exception.getClass().getSimpleName());
        }
    }

    private static UUID uuidOrNull(String value) {
        if (value == null || value.isBlank()) {
            return null;
        }
        try {
            return UUID.fromString(value);
        } catch (IllegalArgumentException exception) {
            return null;
        }
    }
}
