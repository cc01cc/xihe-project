package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.config.ProblemDetailsHandler;
import com.cc01cc.p.xihe.cp.config.TenantContext;
import com.cc01cc.p.xihe.cp.entity.Message;
import com.cc01cc.p.xihe.cp.entity.OperationItem;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.operation.JobStateService;
import com.cc01cc.p.xihe.cp.repository.FileRepository;
import com.cc01cc.p.xihe.cp.repository.ChatRunRepository;
import com.cc01cc.p.xihe.cp.repository.MessageRepository;
import com.cc01cc.p.xihe.cp.repository.OperationItemRepository;
import com.cc01cc.p.xihe.cp.repository.SessionOperationRepository;
import com.cc01cc.p.xihe.cp.service.SessionService;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.*;

import java.util.ArrayList;
import java.util.UUID;
import java.util.LinkedHashMap;
import java.util.UUID;
import java.util.List;
import java.util.UUID;
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
    private final SessionOperationRepository sessionOperationRepository;
    private final OperationItemRepository operationItemRepository;
    private final JobStateService jobStateService;

    public MessageController(MessageRepository messageRepository,
                             ChatRunRepository chatRunRepository,
                             FileRepository fileRepository,
                             SessionService sessionService,
                             ObjectMapper objectMapper,
                             SessionOperationRepository sessionOperationRepository,
                             OperationItemRepository operationItemRepository,
                             JobStateService jobStateService) {
        this.messageRepository = messageRepository;
        this.chatRunRepository = chatRunRepository;
        this.fileRepository = fileRepository;
        this.sessionService = sessionService;
        this.objectMapper = objectMapper;
        this.sessionOperationRepository = sessionOperationRepository;
        this.operationItemRepository = operationItemRepository;
        this.jobStateService = jobStateService;
    }

    @PreAuthorize("hasAnyRole('USER', 'ADMIN')")
    @GetMapping
    public ResponseEntity<?> listMessages(@PathVariable String sessionId) {
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

        List<Message> messages = messageRepository.findBySessionIdOrderByCreatedAtAsc(sessionId);
        List<Map<String, Object>> result = new ArrayList<>();
        for (Message message : messages) {
            result.add(toMessageDto(message));
        }
        return ResponseEntity.ok(result);
    }

    @PreAuthorize("hasAnyRole('USER', 'ADMIN')")
    @DeleteMapping("/{messageId}")
    public ResponseEntity<?> deleteMessage(@PathVariable String sessionId, @PathVariable String messageId) {
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
        Message message = messageRepository.findById(UUID.fromString(messageId)).orElse(null);
        if (message == null || !sessionId.equals(message.getSessionId())) {
            return ProblemDetailsHandler.problemResponse(
                    HttpStatus.NOT_FOUND, "MESSAGE_NOT_FOUND", "Message not found");
        }
        messageRepository.delete(message);
        fileRepository.findByMessageId(messageId)
                .forEach(file -> {
                    file.setMessageId(null);
                    fileRepository.save(file);
                });
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
            chatRunRepository.findById(UUID.fromString(message.getRunId())).ifPresent(run -> {
                dto.put("runId", run.getId());
                dto.put("runStatus", run.getStatus());
                dto.put("terminalOutcome", run.getTerminalOutcome());
                dto.put("errorCode", run.getErrorCode());
                dto.put("errorDetail", run.getErrorDetail());
                dto.put("partial", "partial".equals(run.getStatus()));
            });
            // PLAN-0344 T1.4：刷新后 job 卡片与续看入口的数据源
            // （tool_result 本身不持久化，jobSummary 从账本档案还原）。
            dto.put("jobSummary", jobSummariesForRun(message.getRunId()));
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
        var operation = sessionOperationRepository.findByRunId(runId).orElse(null);
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
