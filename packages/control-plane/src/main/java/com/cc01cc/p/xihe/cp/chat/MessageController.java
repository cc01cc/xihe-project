package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.config.ProblemDetailsHandler;
import com.cc01cc.p.xihe.cp.config.TenantContext;
import com.cc01cc.p.xihe.cp.entity.ChatRun;
import com.cc01cc.p.xihe.cp.entity.Message;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.operation.JobStateService;
import com.cc01cc.p.xihe.cp.repository.FileRepository;
import com.cc01cc.p.xihe.cp.repository.ChatRunRepository;
import com.cc01cc.p.xihe.cp.repository.McpInvocationRepository;
import com.cc01cc.p.xihe.cp.repository.MessageRepository;
import com.cc01cc.p.xihe.cp.service.BranchPathService;
import com.cc01cc.p.xihe.cp.service.SessionService;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.bind.annotation.*;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

@RestController
@RequestMapping("/api/v1/sessions/{sessionId}/messages")
public class MessageController {

    private static final Logger logger = LoggerFactory.getLogger(MessageController.class);

    private final MessageRepository messageRepository;
    private final ChatRunRepository chatRunRepository;
    private final FileRepository fileRepository;
    private final SessionService sessionService;
    private final ObjectMapper objectMapper;
    private final McpInvocationRepository mcpInvocationRepository;
    private final JobStateService jobStateService;
    private final BranchPathService branchPathService;

    public MessageController(MessageRepository messageRepository,
                             ChatRunRepository chatRunRepository,
                             FileRepository fileRepository,
                             SessionService sessionService,
                             ObjectMapper objectMapper,
                             McpInvocationRepository mcpInvocationRepository,
                             JobStateService jobStateService,
                             BranchPathService branchPathService) {
        this.messageRepository = messageRepository;
        this.chatRunRepository = chatRunRepository;
        this.fileRepository = fileRepository;
        this.sessionService = sessionService;
        this.objectMapper = objectMapper;
        this.mcpInvocationRepository = mcpInvocationRepository;
        this.jobStateService = jobStateService;
        this.branchPathService = branchPathService;
    }

    @PreAuthorize("hasAnyRole('USER', 'ADMIN')")
    @GetMapping
    public ResponseEntity<?> listMessages(@PathVariable String sessionId,
                                          @RequestParam(value = "branchId", required = false) String branchId) {
        String userId = TenantContext.getUserId();
        String workspaceId = TenantContext.getWorkspaceId();
        if (userId == null || workspaceId == null) {
            return ProblemDetailsHandler.problemResponse(
                    HttpStatus.UNAUTHORIZED, "AUTHORIZATION_REQUIRED", "Workspace context is required");
        }
        try {
            sessionService.requireCurrent(sessionId, userId, workspaceId);
        } catch (CpApiException e) {
            return ProblemDetailsHandler.problemResponse(e.getStatus(), e.getCode(), e.getMessage());
        }
        if (branchId == null || branchId.isBlank()) {
            return ProblemDetailsHandler.problemResponse(HttpStatus.BAD_REQUEST, "INVALID_REQUEST",
                    "branchId is required");
        }
        try {
            branchId = UUID.fromString(branchId).toString();
        } catch (IllegalArgumentException invalidBranchId) {
            return ProblemDetailsHandler.problemResponse(HttpStatus.BAD_REQUEST, "INVALID_REQUEST",
                    "branchId must be a UUID");
        }

        BranchPathService.BranchVisibility visibility;
        String rootBranchId;
        try {
            visibility = branchPathService.resolveVisibility(sessionId, branchId);
            rootBranchId = branchPathService.resolvePath(sessionId, branchId);
        } catch (CpApiException e) {
            return ProblemDetailsHandler.problemResponse(e.getStatus(), e.getCode(), e.getMessage());
        }

        List<Message> messages = messageRepository.findBySessionIdOrderByCreatedAtAsc(sessionId);
        List<Map<String, Object>> result = new ArrayList<>();
        for (Message message : messages) {
            if (isVisibleOnPath(message, sessionId, workspaceId, rootBranchId, visibility)) {
                result.add(toMessageDto(message));
            }
        }
        return ResponseEntity.ok(result);
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

    @PreAuthorize("hasAnyRole('USER', 'ADMIN')")
    @DeleteMapping("/{messageId}")
    @Transactional
    public ResponseEntity<?> deleteMessage(@PathVariable String sessionId, @PathVariable String messageId) {
        String userId = TenantContext.getUserId();
        String workspaceId = TenantContext.getWorkspaceId();
        if (userId == null || workspaceId == null) {
            return ProblemDetailsHandler.problemResponse(
                    HttpStatus.UNAUTHORIZED, "AUTHORIZATION_REQUIRED", "Workspace context is required");
        }
        try {
            sessionService.lockCurrentForMutation(sessionId, userId, workspaceId);
        } catch (CpApiException e) {
            return ProblemDetailsHandler.problemResponse(e.getStatus(), e.getCode(), e.getMessage());
        }
        Message message = messageRepository.findById(UUID.fromString(messageId)).orElse(null);
        if (message == null || !sessionId.equals(message.getSessionId())) {
            return ProblemDetailsHandler.problemResponse(
                    HttpStatus.NOT_FOUND, "MESSAGE_NOT_FOUND", "Message not found");
        }
        messageRepository.delete(message);
        for (var candidate : fileRepository.findByMessageIdOrderByIdAsc(messageId)) {
            var file = fileRepository.findByIdForUpdate(candidate.getId()).orElse(null);
            if (file != null && messageId.equals(file.getMessageId())) {
                file.setMessageId(null);
                fileRepository.save(file);
            }
        }
        logger.info("Message deleted session={} messageId={} userId={}", sessionId, messageId, userId);
        return ResponseEntity.ok(Map.of("deleted", messageId));
    }

    private Map<String, Object> toMessageDto(Message message) {
        Map<String, Object> dto = new LinkedHashMap<>();
        dto.put("id", message.getId());
        dto.put("sessionId", message.getSessionId());
        dto.put("role", message.getRole().name());
        dto.put("content", message.getContent());
        dto.put("createdAt", message.getCreatedAt());
        if (message.getRunId() != null) {
            ChatRun run = chatRunRepository.findById(UUID.fromString(message.getRunId())).orElse(null);
            // Forked Message rows may keep the parent Run id as nullable lineage.
            // Only the Run owned by this Message's Session is safe for the public view.
            if (run != null && message.getSessionId().equals(run.getSessionId())) {
                dto.put("runId", run.getId());
                dto.put("runStatus", run.getStatus());
                dto.put("terminalOutcome", run.getTerminalOutcome());
                dto.put("errorCode", run.getErrorCode());
                dto.put("errorDetail", run.getErrorDetail());
                dto.put("partial", "partial".equals(run.getStatus()));
                // PLAN-0344 T1.4：刷新后 job 卡片与续看入口的数据源。
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
     * PLAN-0465 T2.2: job summaries are read from `workspace_jobs` by run;
     * `jobId` is the domain identity and `toolName` comes from MCP invocation provenance.
     * This method is read-only; failures return an empty list.
     */
    private List<Map<String, Object>> jobSummariesForRun(String runId) {
        List<Map<String, Object>> summaries = new ArrayList<>();
        try {
            // Resolve tool names from MCP invocation provenance, then project
            // the Workspace Jobs owned by this run.
            Map<String, String> toolNamesByCall = new LinkedHashMap<>();
            for (var invocation : mcpInvocationRepository.findByRunIdOrderByCreatedAtAsc(runId)) {
                if (invocation.getToolCallId() != null && invocation.getToolName() != null) {
                    toolNamesByCall.putIfAbsent(
                            invocation.getToolCallId().toLowerCase(java.util.Locale.ROOT),
                            invocation.getToolName());
                }
            }
            for (com.cc01cc.p.xihe.cp.entity.WorkspaceJob row : jobStateService.listByRun(runId)) {
                Map<String, Object> summary = new LinkedHashMap<>();
                summary.put("jobId", row.getId().toString());
                summary.put("workspaceId", row.getWorkspaceId().toString());
                String toolCallId =
                        row.getToolCallId() == null ? null : row.getToolCallId().toString();
                summary.put("toolCallId", toolCallId);
                String toolName = toolCallId == null ? null
                        : toolNamesByCall.get(toolCallId.toLowerCase(java.util.Locale.ROOT));
                summary.put("toolName", toolName);
                summary.put("status", row.getStatus());
                summary.put("scope", row.getScope());
                summary.put("startedAt",
                        row.getStartedAt() == null ? null : row.getStartedAt().toString());
                summary.put("endedAt", row.getEndedAt() == null ? null : row.getEndedAt().toString());
                summaries.add(summary);
            }
        } catch (RuntimeException e) {
            logger.warn("[LIFECYCLE] service=cp event=job_summary_projection_failed runId={} error={}",
                    runId, e.getMessage());
        }
        logger.info("[LIFECYCLE] service=cp event=job_summary_loaded runId={} count={}",
                runId, summaries.size());
        return summaries;
    }
}
