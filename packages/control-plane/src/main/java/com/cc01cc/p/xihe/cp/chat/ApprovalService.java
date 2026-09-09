package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.entity.ChatApproval;
import com.cc01cc.p.xihe.cp.entity.ChatRun;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.SerializationFeature;
import com.cc01cc.p.xihe.cp.repository.ChatApprovalRepository;
import com.cc01cc.p.xihe.cp.repository.ChatRunRepository;
import com.cc01cc.p.xihe.cp.operation.OperationService;
import com.cc01cc.p.xihe.cp.logging.LogRedactor;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Instant;
import java.util.UUID;
import java.time.temporal.ChronoUnit;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

@Service
public class ApprovalService {

    private static final Logger logger = LoggerFactory.getLogger(ApprovalService.class);
    private static final List<String> REPLAYABLE_STATES = List.of("pending", "dispatching");
    private static final int MAX_ACTION_LENGTH = 512;
    private static final int MAX_DETAILS_LENGTH = 512;
    private static final int MAX_ARGUMENTS_HASH_LENGTH = 96;
    // PLAN-292 M1: canonical form must byte-match the Agent's
    // json.dumps(obj, ensure_ascii=False, sort_keys=True, separators=(",", ":")).
    private static final String HASH_ALGORITHM = "SHA-256";

    private final ChatApprovalRepository approvalRepository;
    private final ChatRunRepository chatRunRepository;
    private final ApprovalAgentClient agentClient;
    private final ObjectMapper objectMapper;
    private final ObjectMapper canonicalMapper;
    private final OperationService operationService;

    public ApprovalService(ChatApprovalRepository approvalRepository,
                           ChatRunRepository chatRunRepository,
                           ApprovalAgentClient agentClient,
                           ObjectMapper objectMapper,
                           OperationService operationService) {
        this.approvalRepository = approvalRepository;
        this.chatRunRepository = chatRunRepository;
        this.agentClient = agentClient;
        this.objectMapper = objectMapper;
        this.canonicalMapper = objectMapper.copy()
                .configure(SerializationFeature.ORDER_MAP_ENTRIES_BY_KEYS, true);
        this.operationService = operationService;
    }

    @Transactional
    public void recordPending(Map<?, ?> payload, String expectedSessionId, String expectedRunId,
                              String userId, String workspaceId) {
        String requestId = required(payload, "requestId");
        String runId = optional(payload, "runId", expectedRunId);
        String sessionId = optional(payload, "sessionId", expectedSessionId);
        if (!expectedRunId.equals(runId) || !expectedSessionId.equals(sessionId)) {
            throw new CpApiException(HttpStatus.BAD_GATEWAY, "AGENT_EVENT_ID_MISMATCH",
                    "Agent approval event does not match the active chat run");
        }
        ChatRun run = chatRunRepository.findById(UUID.fromString(runId)).orElseThrow(() -> new CpApiException(
                HttpStatus.BAD_GATEWAY, "AGENT_EVENT_ID_MISMATCH", "Approval event references an unknown chat run"));
        if (!userId.equals(run.getUserId()) || !workspaceId.equals(run.getWorkspaceId())
                || !sessionId.equals(run.getSessionId())) {
            throw new CpApiException(HttpStatus.BAD_GATEWAY, "AGENT_EVENT_ID_MISMATCH",
                    "Agent approval event ownership does not match the active chat run");
        }
        String action = required(payload, "action");
        String details = optional(payload, "details", "");
        String argumentsHash = optional(payload, "argumentsHash", null);
        if (action.length() > MAX_ACTION_LENGTH || details.length() > MAX_DETAILS_LENGTH
                || (argumentsHash != null && argumentsHash.length() > MAX_ARGUMENTS_HASH_LENGTH)) {
            throw new CpApiException(HttpStatus.BAD_GATEWAY, "AGENT_EVENT_INVALID",
                    "Approval request payload exceeds the size limit");
        }
        Instant expiresAt = parseExpiresAt(payload.get("expiresAt"));
        String snapshotId = optional(payload, "snapshotId", null);
        String policyClass = optional(payload, "policyClass", "unknown");
        ChatApproval existing = approvalRepository.findById(UUID.fromString(requestId)).orElse(null);
        if (existing != null) {
            if (!runId.equals(existing.getRunId()) || !sessionId.equals(existing.getSessionId())
                    || !userId.equals(existing.getUserId()) || !workspaceId.equals(existing.getWorkspaceId())) {
                throw new CpApiException(HttpStatus.BAD_GATEWAY, "AGENT_EVENT_ID_MISMATCH",
                        "Approval request identity changed for an existing requestId");
            }
            recordLedgerApprovalItem(payload, runId, requestId);
            return;
        }
        approvalRepository.save(new ChatApproval(
                requestId,
                runId,
                sessionId,
                userId,
                workspaceId,
                optional(payload, "tool", "request_approval"),
                action,
                details,
                "pending",
                expiresAt,
                snapshotId,
                policyClass,
                argumentsHash));
        recordLedgerApprovalItem(payload, runId, requestId);
        logger.info("[LIFECYCLE] service=cp event=chat_approval_pending requestId={} sessionId={} runId={}",
                requestId, sessionId, runId);
    }

    @Transactional(readOnly = true)
    public List<Map<String, Object>> replayPending(String sessionId, String userId, String workspaceId) {
        return approvalRepository
                .findBySessionIdAndUserIdAndWorkspaceIdAndStateInOrderByCreatedAtAsc(sessionId, userId, workspaceId, REPLAYABLE_STATES)
                .stream()
                .filter(approval -> approval.getExpiresAt().isAfter(Instant.now()))
                .map(approval -> toPayload(approval, true))
                .toList();
    }

    // PLAN-292 M3 (C2): run-scoped recovery view for GET /chat/runs/{runId} —
    // lets a refreshed or reconnected client re-render the pending approval
    // even when the SSE replay path is unavailable. Same fail-closed shape as
    // replayPending: expired rows are dropped, decisions are never fabricated.
    @Transactional(readOnly = true)
    public List<Map<String, Object>> findActiveForRun(String runId, String userId, String workspaceId) {
        return approvalRepository
                .findByRunIdAndStateIn(runId, REPLAYABLE_STATES)
                .stream()
                .filter(approval -> approval.getUserId().equals(userId)
                        && approval.getWorkspaceId().equals(workspaceId)
                        && approval.getExpiresAt().isAfter(Instant.now()))
                .map(approval -> toPayload(approval, true))
                .toList();
    }

    public Map<String, Object> decide(String requestId, String userId, String workspaceId, boolean approved) {
        ChatApproval approval = approvalRepository.findById(parseRequestId(requestId))
                .filter(row -> userId.equals(row.getUserId()) && workspaceId.equals(row.getWorkspaceId()))
                .orElseThrow(() -> new CpApiException(HttpStatus.NOT_FOUND, "APPROVAL_NOT_FOUND", "Approval request not found"));
        Instant now = Instant.now();
        if (approval.getExpiresAt().isBefore(now) && !isTerminal(approval.getState())) {
            int marked = approvalRepository.markExpired(approval.getRequestId(), now);
            if (marked == 0) {
                throw new CpApiException(HttpStatus.CONFLICT, "APPROVAL_DECISION_IN_PROGRESS",
                        "Approval decision is already being dispatched");
            }
            throw new CpApiException(HttpStatus.GONE, "APPROVAL_EXPIRED", "Approval request expired");
        }
        if (isTerminal(approval.getState())) {
            if (approval.getApproved() != null && approval.getApproved() == approved) {
                return decisionResponse(requestId, "accepted", approved);
            }
            throw new CpApiException(HttpStatus.CONFLICT, "APPROVAL_DECISION_CONFLICT",
                    "Approval request already has a different decision");
        }
        // PLAN-290 M0.4 dispatch_unknown reconciliation: a lost dispatch outcome is
        // retryable by an explicit user decision (no automatic replay). Re-entering
        // dispatching from dispatch_unknown is an atomic conditional update.
        if (!"pending".equals(approval.getState()) && !"dispatch_unknown".equals(approval.getState())) {
            throw new CpApiException(HttpStatus.CONFLICT, "APPROVAL_DECISION_IN_PROGRESS",
                    "Approval decision is already being dispatched");
        }
        int claimed = approvalRepository.markDispatching(approval.getRequestId(), approved, now);
        if (claimed == 0) {
            throw new CpApiException(HttpStatus.CONFLICT, "APPROVAL_DECISION_IN_PROGRESS",
                    "Approval decision is already being dispatched");
        }
        try {
            agentClient.respond(requestId, approved);
        } catch (CpApiException e) {
            int marked = approvalRepository.markDispatchUnknown(approval.getRequestId(), e.getCode(), Instant.now());
            if (marked == 0) {
                logger.warn("[LIFECYCLE] service=cp event=chat_approval_dispatch_unknown_skipped requestId={} state was no longer dispatching", requestId);
            }
            throw e;
        }
        int decided = approvalRepository.markDecided(approval.getRequestId(), approved ? "approved" : "rejected", Instant.now());
        if (decided == 0) {
            logger.error("[LIFECYCLE] service=cp event=chat_approval_decide_transition_lost requestId={} expected dispatching state", requestId);
        }
        operationService.resolveApprovalItem(requestId, approved);
        return decisionResponse(requestId, "accepted", approved);
    }

    private void recordLedgerApprovalItem(Map<?, ?> payload, String runId, String requestId) {
        UUID operationId = operationService.findOperationIdByRunId(runId);
        if (operationId == null) {
            return;
        }
        operationService.appendApprovalItem(
                operationId,
                requestId,
                optional(payload, "tool", "request_approval"),
                safeLedgerPreview(payload));
    }

    private String safeLedgerPreview(Map<?, ?> payload) {
        try {
            String redacted = LogRedactor.redact(objectMapper.writeValueAsString(payload));
            return redacted.length() <= 4096 ? redacted : redacted.substring(0, 4096);
        } catch (Exception e) {
            logger.warn("[LIFECYCLE] service=cp event=approval_ledger_preview_failed");
            return "{\"redacted\":true}";
        }
    }

    /**
     * Atomically consumes a policy approval for one exact MCP tool invocation.
     * The approval row remains terminally approved; grant_consumed_at records
     * whether this particular downstream dispatch already used it.
     */
    @Transactional
    public boolean consumeApprovedGrant(String requestId, String userId, String workspaceId,
                                        String sessionId, String tool, String mcpBody) {
        UUID requestUuid;
        try {
            requestUuid = UUID.fromString(requestId);
        } catch (IllegalArgumentException e) {
            return false;
        }
        ChatApproval approval = approvalRepository.findById(requestUuid)
                .filter(row -> userId.equals(row.getUserId())
                        && workspaceId.equals(row.getWorkspaceId())
                        && sessionId.equals(row.getSessionId())
                        && tool.equals(row.getTool())
                        && "approved".equals(row.getState())
                        && row.getGrantConsumedAt() == null)
                .orElse(null);
        if (approval == null || !matchesInvocation(approval, tool, mcpBody)) {
            return false;
        }
        int consumed = approvalRepository.consumeApprovedGrant(
                requestUuid, userId, workspaceId, sessionId, tool, Instant.now());
        if (consumed == 1) {
            logger.info("[LIFECYCLE] service=cp event=approval_grant_consumed requestId={} sessionId={} tool={}",
                    requestId, sessionId, tool);
            return true;
        }
        logger.info("[LIFECYCLE] service=cp event=approval_grant_replay_rejected requestId={} sessionId={} tool={}",
                requestId, sessionId, tool);
        return false;
    }

    // PLAN-292 M1 (H1): match by canonical arguments hash first so a truncated
    // preview cannot fail an approved large write (409 after approval). Rows
    // without a stored hash (pre-V9) keep the legacy whole-JSON comparison.
    // Every miss stays fail-closed: the caller maps false to 409/404 upstream.
    private boolean matchesInvocation(ChatApproval approval, String tool, String mcpBody) {
        String storedHash = approval.getArgumentsHash();
        if (storedHash != null && !storedHash.isBlank()) {
            return matchesArgumentsHash(storedHash, tool, mcpBody);
        }
        return matchesMcpInvocation(approval.getDetails(), tool, mcpBody);
    }

    // Canonical form is the Agent's approval details payload:
    // {"tool": <tool>, "arguments": <mcp params.arguments>} serialized with
    // sorted keys, compact separators and raw UTF-8 (Python json.dumps
    // ensure_ascii=False, sort_keys=True, separators=(",", ":")).
    private boolean matchesArgumentsHash(String storedHash, String tool, String mcpBody) {
        try {
            JsonNode arguments = objectMapper.readTree(mcpBody).path("params").path("arguments");
            if (arguments.isMissingNode()) {
                logger.warn("[LIFECYCLE] service=cp event=approval_grant_hash_mismatch tool={} reason=missing_arguments", tool);
                return false;
            }
            Map<String, Object> invocation = new LinkedHashMap<>();
            invocation.put("tool", tool);
            invocation.put("arguments", objectMapper.convertValue(arguments, Object.class));
            String computed = "sha256:" + hexSha256(canonicalMapper.writeValueAsString(invocation));
            if (!computed.equals(normalizeStoredHash(storedHash))) {
                logger.info("[LIFECYCLE] service=cp event=approval_grant_hash_mismatch tool={}", tool);
                return false;
            }
            return true;
        } catch (Exception e) {
            logger.warn("[LIFECYCLE] service=cp event=approval_grant_payload_invalid tool={} reason={}",
                    tool, e.getMessage());
            return false;
        }
    }

    private static String normalizeStoredHash(String storedHash) {
        String normalized = storedHash.trim();
        return normalized.startsWith("sha256:") ? normalized : "sha256:" + normalized;
    }

    private static String hexSha256(String canonical) {
        try {
            byte[] digest = MessageDigest.getInstance(HASH_ALGORITHM)
                    .digest(canonical.getBytes(StandardCharsets.UTF_8));
            StringBuilder hex = new StringBuilder(digest.length * 2);
            for (byte b : digest) {
                hex.append(Character.forDigit((b >> 4) & 0xF, 16))
                        .append(Character.forDigit(b & 0xF, 16));
            }
            return hex.toString();
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("SHA-256 message digest unavailable", e);
        }
    }

    private boolean matchesMcpInvocation(String details, String tool, String mcpBody) {
        try {
            JsonNode approved = objectMapper.readTree(details);
            JsonNode current = objectMapper.readTree(mcpBody);
            return tool.equals(approved.path("tool").asText())
                    && approved.path("arguments").equals(current.path("params").path("arguments"));
        } catch (Exception e) {
            logger.warn("[LIFECYCLE] service=cp event=approval_grant_payload_invalid tool={} reason={}",
                    tool, e.getMessage());
            return false;
        }
    }

    private Map<String, Object> toPayload(ChatApproval approval, boolean replayed) {
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("requestId", approval.getRequestId());
        payload.put("runId", approval.getRunId());
        payload.put("sessionId", approval.getSessionId());
        payload.put("workspaceId", approval.getWorkspaceId());
        payload.put("tool", approval.getTool());
        payload.put("action", approval.getAction());
        payload.put("details", approval.getDetails());
        payload.put("snapshotId", approval.getSnapshotId());
        payload.put("policyClass", approval.getPolicyClass());
        payload.put("expiresAt", approval.getExpiresAt());
        payload.put("replayed", replayed);
        return payload;
    }

    private Map<String, Object> decisionResponse(String requestId, String status, boolean approved) {
        Map<String, Object> response = new LinkedHashMap<>();
        response.put("status", status);
        response.put("requestId", requestId);
        response.put("approved", approved);
        return response;
    }

    private boolean isTerminal(String state) {
        return "approved".equals(state) || "rejected".equals(state) || "expired".equals(state);
    }

    /** Malformed ids must surface as 400 INVALID_REQUEST, never a raw 500 (PLAN-290 M0.4). */
    private UUID parseRequestId(String requestId) {
        try {
            return UUID.fromString(requestId);
        } catch (Exception e) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST", "requestId is invalid", e);
        }
    }

    private String required(Map<?, ?> payload, String key) {
        String value = optional(payload, key, "");
        if (value.isBlank()) {
            throw new CpApiException(HttpStatus.BAD_GATEWAY, "AGENT_EVENT_INVALID", key + " is required");
        }
        return value;
    }

    private String optional(Map<?, ?> payload, String key, String fallback) {
        Object value = payload.get(key);
        return value == null ? fallback : String.valueOf(value);
    }

    private Instant parseExpiresAt(Object raw) {
        if (raw == null) return Instant.now().plus(5, ChronoUnit.MINUTES);
        try {
            return Instant.parse(String.valueOf(raw));
        } catch (Exception e) {
            throw new CpApiException(HttpStatus.BAD_GATEWAY, "AGENT_EVENT_INVALID", "expiresAt is invalid", e);
        }
    }
}
