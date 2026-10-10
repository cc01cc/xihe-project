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

    private final MessageRepository messageRepository;
    private final ChatRunRepository chatRunRepository;
    private final McpInvocationService mcpInvocationService;
    private final JobStateService jobStateService;
    private final BranchPathService branchPathService;
    private final ObjectMapper objectMapper;

    public MessageReadService(MessageRepository messageRepository,
                              ChatRunRepository chatRunRepository,
                              McpInvocationService mcpInvocationService,
                              JobStateService jobStateService,
                              BranchPathService branchPathService,
                              ObjectMapper objectMapper) {
        this.messageRepository = messageRepository;
        this.chatRunRepository = chatRunRepository;
        this.mcpInvocationService = mcpInvocationService;
        this.jobStateService = jobStateService;
        this.branchPathService = branchPathService;
        this.objectMapper = objectMapper;
    }

    public List<Map<String, Object>> listVisibleMessages(String sessionId, String workspaceId,
                                                          String rootBranchId,
                                                          BranchPathService.BranchVisibility visibility) {
        List<Map<String, Object>> result = new ArrayList<>();
        for (Message message : messageRepository.findBySessionIdOrderByCreatedAtAsc(sessionId)) {
            if (isVisibleOnPath(message, sessionId, workspaceId, rootBranchId, visibility)) {
                result.add(toMessageDto(message));
            }
        }
        return result;
    }

    Optional<DispatchMessage> findDispatchMessage(String messageId) {
        return messageRepository.findById(UUID.fromString(messageId))
                .map(message -> new DispatchMessage(
                        message.getSessionId(), message.getRunId(), message.getContent(), message.getAttachments()));
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
