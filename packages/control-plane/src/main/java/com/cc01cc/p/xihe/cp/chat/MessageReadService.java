package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.entity.ChatRun;
import com.cc01cc.p.xihe.cp.entity.Message;
import com.cc01cc.p.xihe.cp.operation.JobStateService;
import com.cc01cc.p.xihe.cp.repository.ChatRunRepository;
import com.cc01cc.p.xihe.cp.repository.MessageRepository;
import com.cc01cc.p.xihe.cp.mcp.McpInvocationService;
import com.cc01cc.p.xihe.cp.service.BranchPathService;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;

/** Read-side message listing and response projection. */
@Service
public class MessageReadService {

    private static final Logger logger = LoggerFactory.getLogger(MessageReadService.class);

    /**
     * PLAN-0670 M2b: hard ceiling for the <b>legacy full-read</b> path ({@code GET /messages} without
     * {@code limit}/{@code before}). Kept equal to the BL-279 export cap on purpose — both guards are
     * "count before reading", so they must not drift into two different numbers.
     */
    public static final int MAX_FULL_READ_MESSAGES = SessionExportService.MAX_MESSAGES;

    private final MessageRepository messageRepository;
    private final ChatRunRepository chatRunRepository;
    private final McpInvocationService mcpInvocationService;
    private final JobStateService jobStateService;
    private final BranchPathService branchPathService;
    private final ObjectMapper objectMapper;
    private final SessionReadMemoryGuard memoryGuard;

    public MessageReadService(MessageRepository messageRepository,
                              ChatRunRepository chatRunRepository,
                              McpInvocationService mcpInvocationService,
                              JobStateService jobStateService,
                              BranchPathService branchPathService,
                              ObjectMapper objectMapper,
                              SessionReadMemoryGuard memoryGuard) {
        this.messageRepository = messageRepository;
        this.chatRunRepository = chatRunRepository;
        this.mcpInvocationService = mcpInvocationService;
        this.jobStateService = jobStateService;
        this.branchPathService = branchPathService;
        this.objectMapper = objectMapper;
        this.memoryGuard = memoryGuard;
    }

    public List<Map<String, Object>> listVisibleMessages(String sessionId, String workspaceId,
                                                          String rootBranchId,
                                                          BranchPathService.BranchVisibility visibility) {
        return listVisibleMessages(sessionId, workspaceId, rootBranchId, visibility, "messages.list");
    }

    /**
     * Same as {@link #listVisibleMessages(String, String, String, BranchPathService.BranchVisibility)}
     * with an explicit read-path label for the heap watermark (T2b.4). Callers that materialise a whole
     * conversation (messages list, export) pass their own label so the diagnostic line says which read
     * path grew.
     */
    public List<Map<String, Object>> listVisibleMessages(String sessionId, String workspaceId,
                                                          String rootBranchId,
                                                          BranchPathService.BranchVisibility visibility,
                                                          String endpointLabel) {
        List<Map<String, Object>> result = new ArrayList<>();
        for (Message message : messageRepository.findBySessionIdOrderByCreatedAtAsc(sessionId)) {
            // PLAN-0630 M5b / D3: internal Messages (wake instructions) are model input only — they
            // never render in the conversation. The filter lives here, in the single public read
            // entry, so no caller can forget it; dispatch reads the content via findDispatchMessage.
            if (!Message.VISIBILITY_USER.equals(message.getVisibility())) {
                continue;
            }
            if (isVisibleOnPath(message, sessionId, workspaceId, rootBranchId, visibility)) {
                result.add(toMessageDto(message));
            }
        }
        // PLAN-0670 M2b (T2b.4): one WARN line when this read path materialises a large conversation.
        // Estimate only — never log content (privacy) — and stay silent unless the deployment turned
        // the guard on and the estimate crosses its threshold.
        memoryGuard.observe(endpointLabel, result.size(), estimateResponseBytes(result));
        return result;
    }

    /**
     * Footprint estimate for the watermark: UTF-16 content (2 bytes/char) plus a fixed per-row
     * overhead for the DTO map/keys. Deliberately coarse — it only decides "worth a WARN line".
     */
    static long estimateResponseBytes(List<Map<String, Object>> messages) {
        long estimated = 0L;
        for (Map<String, Object> message : messages) {
            estimated += 256L;
            if (message.get("content") instanceof String content) {
                estimated += 2L * content.length();
            }
        }
        return estimated;
    }

    /** Hard upper bound of {@code ?limit=}; larger values are truncated (never rejected). */
    public static final int MAX_PAGE_LIMIT = 200;

    /** One page plus the envelope fields of PLAN-0670 M2. */
    public record MessagePage(List<Map<String, Object>> messages, int limit, boolean truncated,
                              String nextCursor) {
    }

    private record MessageCursor(java.time.Instant createdAt, UUID id) {
    }

    /**
     * PLAN-0670 M2 cursor pagination.
     *
     * <p>Returns the newest {@code limit} visible messages of the branch path (ascending), or the
     * page strictly older than {@code beforeCursor}. The cursor is opaque and encodes the composite
     * {@code (createdAt, id)} boundary of the oldest returned row; a single timestamp key would
     * skip/duplicate rows whenever several messages share the same millisecond.</p>
     *
     * <p>Visibility is a Java predicate (branch-path anchors), so rows are scanned newest-first in
     * bounded batches and filtered before counting towards {@code limit}: memory stays bounded by
     * the scanned window plus {@code limit}, never by the whole session.</p>
     */
    public MessagePage listVisibleMessagesPage(String sessionId, String workspaceId,
                                               String rootBranchId,
                                               BranchPathService.BranchVisibility visibility,
                                               int limit, String beforeCursor) {
        int effectiveLimit = Math.max(1, Math.min(limit, MAX_PAGE_LIMIT));
        MessageCursor cursor = beforeCursor == null || beforeCursor.isBlank()
                ? null : decodeCursor(beforeCursor);
        List<Message> collected = new ArrayList<>();
        int batch = Math.max(effectiveLimit + 1, 64);
        while (true) {
            List<Message> page = cursor == null
                    ? messageRepository.findLatestPage(sessionId,
                            org.springframework.data.domain.PageRequest.of(0, batch))
                    : messageRepository.findPageBefore(sessionId, cursor.createdAt(), cursor.id(),
                            org.springframework.data.domain.PageRequest.of(0, batch));
            if (page.isEmpty()) {
                break;
            }
            for (Message message : page) {
                if (Message.VISIBILITY_USER.equals(message.getVisibility())
                        && isVisibleOnPath(message, sessionId, workspaceId, rootBranchId, visibility)) {
                    collected.add(message);
                }
                if (collected.size() > effectiveLimit) {
                    break;
                }
            }
            if (collected.size() > effectiveLimit || page.size() < batch) {
                break;
            }
            Message oldest = page.get(page.size() - 1);
            cursor = new MessageCursor(oldest.getCreatedAt(), oldest.getId());
        }
        boolean truncated = collected.size() > effectiveLimit;
        List<Message> window = new ArrayList<>(
                collected.subList(0, Math.min(effectiveLimit, collected.size())));
        java.util.Collections.reverse(window);
        List<Map<String, Object>> messages = new ArrayList<>(window.size());
        for (Message message : window) {
            messages.add(toMessageDto(message));
        }
        // Boundary for the next (older) page: the OLDEST row of the returned window.
        String nextCursor = truncated && !window.isEmpty()
                ? encodeCursor(window.get(0).getCreatedAt(), window.get(0).getId())
                : null;
        return new MessagePage(messages, effectiveLimit, truncated, nextCursor);
    }

    static String encodeCursor(java.time.Instant createdAt, UUID id) {
        String raw = createdAt.toString() + "|" + id;
        return java.util.Base64.getUrlEncoder().withoutPadding()
                .encodeToString(raw.getBytes(java.nio.charset.StandardCharsets.UTF_8));
    }

    private static MessageCursor decodeCursor(String cursor) {
        try {
            String raw = new String(java.util.Base64.getUrlDecoder().decode(cursor),
                    java.nio.charset.StandardCharsets.UTF_8);
            int split = raw.lastIndexOf('|');
            return new MessageCursor(java.time.Instant.parse(raw.substring(0, split)),
                    UUID.fromString(raw.substring(split + 1)));
        } catch (RuntimeException invalid) {
            throw new CpApiException(org.springframework.http.HttpStatus.BAD_REQUEST,
                    "INVALID_CURSOR", "before must be an opaque cursor returned by this endpoint");
        }
    }

    Optional<DispatchMessage> findDispatchMessage(String messageId) {        return messageRepository.findById(UUID.fromString(messageId))
                .map(message -> new DispatchMessage(
                        message.getSessionId(), message.getRunId(), message.getContent(), message.getAttachments()));
    }

    /**
     * BL-279: cheap session-wide message count for the export precheck. Counts **all** rows (every
     * branch and visibility) because the cap guards CP memory before any message is materialised;
     * the export is refused rather than silently truncated. Uses {@code idx_messages_session_id}.
     */
    public long countSessionMessages(String sessionId) {
        return messageRepository.countBySessionId(sessionId);
    }

    private boolean isVisibleOnPath(Message message, String sessionId, String workspaceId,
                                    String rootBranchId,
                                    BranchPathService.BranchVisibility visibility) {
        String messageBranchId = message.getBranchId();
        if (messageBranchId == null || messageBranchId.isBlank()) {
            return false;
        }
        if (messageBranchId.equals(visibility.currentBranchId())) {
            return true;
        }
        if (!visibility.ancestorCutoffs().containsKey(messageBranchId)) {
            return false;
        }
        if (message.getRunId() == null || message.getRunId().isBlank()) {
            return messageBranchId.equals(rootBranchId);
        }
        try {
            BranchPathService.AnchorResolution cursor = branchPathService.resolveAnchor(
                    sessionId, workspaceId, message.getId().toString());
            return visibility.isVisible(cursor.branchId(), cursor.cursor());
        } catch (CpApiException e) {
            if ("BRANCH_ANCHOR_UNAVAILABLE".equals(e.getCode())
                    || "BRANCH_ANCHOR_RUN_ACTIVE".equals(e.getCode())
                    || "BRANCH_ANCHOR_ROLE_UNSUPPORTED".equals(e.getCode())) {
                return false;
            }
            throw e;
        }
    }

    private Map<String, Object> toMessageDto(Message message) {
        Map<String, Object> dto = new LinkedHashMap<>();
        dto.put("id", message.getId());
        dto.put("sessionId", message.getSessionId());
        dto.put("role", message.getRole().name());
        dto.put("content", message.getContent());
        dto.put("createdAt", message.getCreatedAt());
        // PLAN-0669 M1b (V121): durable actor attribution — the participant id the UI resolves
        // against the roster. Omitted (not null) for pre-V121 rows and for user messages (v1), so
        // clients keep the single "no attribution ⇒ no badge" path (D4) instead of an "unknown" state.
        if (message.getParticipantId() != null) {
            dto.put("participantId", message.getParticipantId());
        }
        putToolCalls(dto, message);
        putDelivery(dto, message);
        if (message.getRunId() != null) {
            ChatRun run = chatRunRepository.findById(java.util.UUID.fromString(message.getRunId())).orElse(null);
            // Forked Message rows may keep the parent Run id as nullable lineage.
            // Only the Run owned by this Message's Session is safe for the public view.
            if (run != null && message.getSessionId().equals(run.getSessionId())) {
                dto.put("runId", run.getId());
                dto.put("runStatus", run.getStatus());
                dto.put("terminalOutcome", run.getTerminalOutcome());
                dto.put("errorCode", run.getErrorCode());
                dto.put("errorDetail", run.getErrorDetail());
                dto.put("partial", "partial".equals(run.getStatus()));
                // Parent-run job summaries are not projected onto a fork child.
                dto.put("jobSummary", jobSummariesForRun(message.getRunId()));
            }
        }
        if (message.getAttachments() != null && !message.getAttachments().isBlank()) {
            try {
                List<Map<String, Object>> attachments = objectMapper.readValue(
                        message.getAttachments(), new TypeReference<List<Map<String, Object>>>() { });
                dto.put("attachments", attachments);
            } catch (Exception e) {
                logger.warn("Failed to parse attachments for message={}", message.getId(), e);
                dto.put("attachments", new ArrayList<>());
            }
        } else {
            dto.put("attachments", new ArrayList<>());
        }
        return dto;
    }

    /**
     * PLAN-0665 D3 (V120): expose the durable TO / CC audience. Same fail-soft rule as tool calls —
     * a malformed payload must never break the message listing (the field is simply omitted).
     */
    private void putDelivery(Map<String, Object> dto, Message message) {
        String deliveryJson = message.getDelivery();
        if (deliveryJson == null || deliveryJson.isBlank()) {
            return;
        }
        try {
            @SuppressWarnings("unchecked")
            Map<String, Object> delivery = objectMapper.readValue(deliveryJson, Map.class);
            dto.put("delivery", delivery);
        } catch (com.fasterxml.jackson.core.JsonProcessingException | IllegalArgumentException e) {
            logger.warn("[LIFECYCLE] service=cp event=message_delivery_projection_failed messageId={} "
                            + "errorType={}", message.getId(), e.getClass().getSimpleName());
        }
    }
    /** PLAN-0572: expose the Message's bounded snapshot; parse failures never break the listing. */
    private void putToolCalls(Map<String, Object> dto, Message message) {
        String snapshotJson = message.getToolCalls();
        if (snapshotJson == null || snapshotJson.isBlank()) {
            return;
        }
        try {
            var snapshot = objectMapper.readTree(snapshotJson);
            var calls = snapshot.path("calls");
            if (!calls.isArray() || calls.isEmpty()) {
                return;
            }
            dto.put("toolCalls", objectMapper.convertValue(
                    calls, new TypeReference<List<Map<String, Object>>>() { }));
            if (snapshot.path("truncated").asBoolean(false)) {
                dto.put("toolCallsTruncated", true);
                dto.put("toolCallsTotal", snapshot.path("total").asInt(calls.size()));
            }
        } catch (com.fasterxml.jackson.core.JsonProcessingException | IllegalArgumentException e) {
            logger.warn("[LIFECYCLE] service=cp event=tool_calls_projection_failed messageId={} errorType={}",
                    message.getId(), e.getClass().getSimpleName(), e);
        }
    }

    /** Failures remain visible in logs while the message listing remains available without job cards. */
    private List<Map<String, Object>> jobSummariesForRun(String runId) {
        List<Map<String, Object>> summaries = new ArrayList<>();
        try {
            Map<String, String> toolNamesByCall = mcpInvocationService.toolNamesByCallForRun(runId);
            for (com.cc01cc.p.xihe.cp.entity.WorkspaceJob row : jobStateService.listByRun(runId)) {
                Map<String, Object> summary = new LinkedHashMap<>();
                summary.put("jobId", row.getId().toString());
                summary.put("workspaceId", row.getWorkspaceId().toString());
                String toolCallId = row.getToolCallId() == null ? null : row.getToolCallId().toString();
                summary.put("toolCallId", toolCallId);
                String toolName = toolCallId == null ? null
                        : toolNamesByCall.get(toolCallId.toLowerCase(java.util.Locale.ROOT));
                summary.put("toolName", toolName);
                summary.put("status", row.getStatus());
                summary.put("scope", row.getScope());
                summary.put("startedAt", row.getStartedAt() == null ? null : row.getStartedAt().toString());
                summary.put("endedAt", row.getEndedAt() == null ? null : row.getEndedAt().toString());
                summaries.add(summary);
            }
        } catch (RuntimeException e) {
            logger.warn("[LIFECYCLE] service=cp event=job_summary_projection_failed runId={} error={}",
                    runId, e.getMessage());
        }
        logger.info("[LIFECYCLE] service=cp event=job_summary_loaded runId={} count={}", runId, summaries.size());
        return summaries;
    }

    record DispatchMessage(String sessionId, String runId, String content, String attachments) {
    }
}
