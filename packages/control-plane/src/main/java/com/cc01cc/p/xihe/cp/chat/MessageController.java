package com.cc01cc.p.xihe.cp.chat;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.*;
import com.cc01cc.p.xihe.cp.config.TenantContext;
import com.cc01cc.p.xihe.cp.entity.Message;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.repository.FileRepository;
import com.cc01cc.p.xihe.cp.repository.MessageRepository;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceUserRepository;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;

@RestController
@RequestMapping("/api/v1/sessions/{sessionId}/messages")
public class MessageController {

    private static final Logger logger = LoggerFactory.getLogger(MessageController.class);

    private final MessageRepository messageRepository;
    private final SessionRepository sessionRepository;
    private final FileRepository fileRepository;
    private final WorkspaceUserRepository workspaceUserRepository;
    private final ObjectMapper objectMapper;

    public MessageController(MessageRepository messageRepository,
                             SessionRepository sessionRepository,
                             FileRepository fileRepository,
                             WorkspaceUserRepository workspaceUserRepository,
                             ObjectMapper objectMapper) {
        this.messageRepository = messageRepository;
        this.sessionRepository = sessionRepository;
        this.fileRepository = fileRepository;
        this.workspaceUserRepository = workspaceUserRepository;
        this.objectMapper = objectMapper;
    }

    @PreAuthorize("hasAnyRole('USER', 'ADMIN')")
    @GetMapping
    public ResponseEntity<?> listMessages(@PathVariable String sessionId) {
        String userId = TenantContext.getUserId();
        String workspaceId = TenantContext.getWorkspaceId();
        if (userId == null || workspaceId == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).body(Map.of("error", "Missing workspace context"));
        }
        try {
            Session session = sessionRepository.findById(sessionId)
                    .orElseThrow(() -> new IllegalArgumentException("Session not found: " + sessionId));
            verifyAccess(userId, workspaceId, session);

            List<Message> messages = messageRepository.findBySessionIdOrderByCreatedAtAsc(sessionId);
            List<Map<String, Object>> result = new ArrayList<>();
            for (Message message : messages) {
                result.add(toMessageDto(message));
            }
            return ResponseEntity.ok(result);
        } catch (IllegalArgumentException e) {
            logger.warn("List messages failed session={} reason={}", sessionId, e.getMessage());
            return ResponseEntity.status(HttpStatus.NOT_FOUND).body(Map.of("error", e.getMessage()));
        } catch (Exception e) {
            logger.error("List messages failed session={}", sessionId, e);
            return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR).body(Map.of("error", e.getMessage()));
        }
    }

    @PreAuthorize("hasAnyRole('USER', 'ADMIN')")
    @DeleteMapping("/{messageId}")
    public ResponseEntity<?> deleteMessage(@PathVariable String sessionId, @PathVariable String messageId) {
        String userId = TenantContext.getUserId();
        String workspaceId = TenantContext.getWorkspaceId();
        if (userId == null || workspaceId == null) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED).body(Map.of("error", "Missing workspace context"));
        }
        try {
            Session session = sessionRepository.findById(sessionId)
                    .orElseThrow(() -> new IllegalArgumentException("Session not found: " + sessionId));
            verifyAccess(userId, workspaceId, session);

            Message message = messageRepository.findById(messageId)
                    .orElseThrow(() -> new IllegalArgumentException("Message not found: " + messageId));
            if (!sessionId.equals(message.getSessionId())) {
                return ResponseEntity.status(HttpStatus.FORBIDDEN).body(Map.of("error", "Message does not belong to session"));
            }
            messageRepository.delete(message);
            logger.info("Message deleted session={} messageId={} userId={}", sessionId, messageId, userId);
            return ResponseEntity.ok(Map.of("deleted", messageId));
        } catch (IllegalArgumentException e) {
            logger.warn("Delete message failed session={} messageId={} reason={}", sessionId, messageId, e.getMessage());
            return ResponseEntity.status(HttpStatus.NOT_FOUND).body(Map.of("error", e.getMessage()));
        } catch (Exception e) {
            logger.error("Delete message failed session={} messageId={}", sessionId, messageId, e);
            return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR).body(Map.of("error", e.getMessage()));
        }
    }

    private void verifyAccess(String userId, String workspaceId, Session session) {
        if (!workspaceId.equals(session.getWorkspaceId())) {
            throw new IllegalArgumentException("Session does not belong to workspace");
        }
        if (!workspaceUserRepository.findByIdWorkspaceIdAndIdUserId(workspaceId, userId).isPresent()) {
            throw new IllegalArgumentException("User is not a member of the workspace");
        }
    }

    private Map<String, Object> toMessageDto(Message message) {
        Map<String, Object> dto = new java.util.LinkedHashMap<>();
        dto.put("id", message.getId());
        dto.put("sessionId", message.getSessionId());
        dto.put("role", message.getRole().name());
        dto.put("content", message.getContent());
        dto.put("createdAt", message.getCreatedAt());
        if (message.getAttachments() != null && !message.getAttachments().isBlank()) {
            try {
                List<Map<String, Object>> attachments = objectMapper.readValue(message.getAttachments(), new TypeReference<List<Map<String, Object>>>() {});
                dto.put("attachments", attachments);
            } catch (JsonProcessingException e) {
                logger.warn("Failed to parse attachments for message={}", message.getId(), e);
                dto.put("attachments", new ArrayList<>());
            }
        } else {
            dto.put("attachments", new ArrayList<>());
        }
        return dto;
    }
}
