package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.config.ProblemDetailsHandler;
import com.cc01cc.p.xihe.cp.config.TenantContext;
import com.cc01cc.p.xihe.cp.entity.ChatRun;
import com.cc01cc.p.xihe.cp.entity.Message;
import com.cc01cc.p.xihe.cp.entity.OperationItem;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.operation.JobStateService;
import com.cc01cc.p.xihe.cp.repository.FileRepository;
import com.cc01cc.p.xihe.cp.repository.ChatRunRepository;
import com.cc01cc.p.xihe.cp.repository.MessageRepository;
import com.cc01cc.p.xihe.cp.repository.OperationItemRepository;
import com.cc01cc.p.xihe.cp.repository.LedgerOperationRepository;
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
    private final LedgerOperationRepository ledgerOperationRepository;
    private final OperationItemRepository operationItemRepository;
    private final JobStateService jobStateService;
    private final BranchPathService branchPathService;

    public MessageController(MessageRepository messageRepository,
                             ChatRunRepository chatRunRepository,
                             FileRepository fileRepository,
                             SessionService sessionService,
                             ObjectMapper objectMapper,
                             LedgerOperationRepository ledgerOperationRepository,
                             OperationItemRepository operationItemRepository,
                             JobStateService jobStateService,
                             BranchPathService branchPathService) {
        this.messageRepository = messageRepository;
        this.chatRunRepository = chatRunRepository;
        this.fileRepository = fileRepository;
        this.sessionService = sessionService;
        this.objectMapper = objectMapper;
        this.ledgerOperationRepository = ledgerOperationRepository;
        this.operationItemRepository = operationItemRepository;
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
     * PLAN-0344 T1.4：run 的 operation → job 工具 items → job_state 档案，
     * 给出可重建 job 卡片的摘要（toolCallId 为 UI 关联键，itemId 为续看键）。
     */
    private List<Map<String, Object>> jobSummariesForRun(String runId) {
        List<Map<String, Object>> summaries = new ArrayList<>();
        var operation = ledgerOperationRepository.findByRunId(runId).orElse(null);
        if (operation == null) {
            return summaries;
        }
        List<OperationItem> items =
                operationItemRepository.findByOperationIdOrderBySequenceAsc(operation.getId().toString());
        for (OperationItem item : items) {
            if (!JobStateService.isJobTool(item.getToolName())) {
                continue;
            }
            jobStateService.find(item.getId()).ifPresent(archive -> {
                Map<String, Object> summary = new LinkedHashMap<>();
                summary.put("itemId", item.getId());
                summary.put("toolCallId", item.getToolCallId());
                summary.put("toolName", item.getToolName());
                summary.put("jobId", archive.jobId());
                summary.put("status", archive.status());
                summary.put("scope", archive.scope());
                summary.put("startedAt", archive.startedAt());
                summary.put("endedAt", archive.endedAt());
                summaries.add(summary);
            });
        }
        return summaries;
    }
}
