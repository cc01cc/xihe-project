package com.cc01cc.p.xihe.cp.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import com.cc01cc.p.xihe.cp.entity.Message;
import com.cc01cc.p.xihe.cp.entity.MessageRole;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.policy.GrantDefaultService;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.cc01cc.p.xihe.cp.repository.MessageRepository;

import java.time.Instant;
import java.util.UUID;

@Service
public class ImportService {

    private static final Logger logger = LoggerFactory.getLogger(ImportService.class);
    private static final long IMPORT_MAX_SIZE = 500 * 1024 * 1024;

    private final SessionRepository sessionRepository;
    private final MessageRepository messageRepository;
    private final ObjectMapper objectMapper;
    private final GrantDefaultService grantDefaultService;
    private final TransactionTemplate transactionTemplate;

    public ImportService(SessionRepository sessionRepository,
                         MessageRepository messageRepository,
                         ObjectMapper objectMapper,
                         GrantDefaultService grantDefaultService,
                         PlatformTransactionManager transactionManager) {
        this.sessionRepository = sessionRepository;
        this.messageRepository = messageRepository;
        this.objectMapper = objectMapper;
        this.grantDefaultService = grantDefaultService;
        this.transactionTemplate = new TransactionTemplate(transactionManager);
    }

    public ImportResult importChats(String json, String userId, String workspaceId) {
        ImportResult result = new ImportResult();
        JsonNode chats;
        try {
            JsonNode root = objectMapper.readTree(json);
            chats = root == null ? null : root.get("chats");
            if (chats == null || !chats.isArray()) {
                result.addError("Invalid format: missing 'chats' array");
                return result;
            }
        } catch (Exception e) {
            logger.error("Import failed", e);
            result.addError(e.getMessage());
            return result;
        }

        for (JsonNode chat : chats) {
            JsonNode idNode = chat == null ? null : chat.get("id");
            String id = idNode == null ? "unknown" : idNode.asText();
            UUID parsedId;
            try {
                parsedId = UUID.fromString(id);
            } catch (IllegalArgumentException e) {
                result.addSkipped(id);
                continue;
            }

            try {
                boolean imported = transactionTemplate.execute(status -> importChat(
                        chat, id, parsedId, userId, workspaceId));
                if (Boolean.TRUE.equals(imported)) {
                    result.addImported(id);
                } else {
                    result.addSkipped(id);
                }
            } catch (RuntimeException e) {
                logger.error("Import failed for chat {}", id, e);
                result.addError(id + ": " + e.getMessage());
            }
        }
        return result;
    }

    private boolean importChat(JsonNode chat, String id, UUID parsedId, String userId, String workspaceId) {
        if (sessionRepository.existsById(parsedId)) {
            return false;
        }
        Session session = new Session();
        session.setId(parsedId);
        session.setUserId(userId);
        session.setWorkspaceId(workspaceId);
        session.setTitle(chat.path("title").asText("Imported"));
        session.setCreatedAt(Instant.parse(chat.path("createdAt").asText()));
        session.setArchived(false);
        Session saved = sessionRepository.save(session);
        grantDefaultService.ensureAgentSessionDefault(saved);

        JsonNode messages = chat.get("messages");
        if (messages != null) {
            for (JsonNode message : messages) {
                Message importedMessage = new Message();
                importedMessage.setSessionId(id);
                importedMessage.setRole(MessageRole.valueOf(message.path("role").asText().toUpperCase()));
                importedMessage.setContent(message.path("content").asText());
                importedMessage.setCreatedAt(Instant.parse(message.path("createdAt").asText()));
                messageRepository.save(importedMessage);
            }
        }
        return true;
    }

    public static class ImportResult {
        private int imported;
        private int skipped;
        private String lastError;

        void addImported(String id) { imported++; }
        void addSkipped(String id) { skipped++; }
        void addError(String err) { this.lastError = err; }

        public int getImported() { return imported; }
        public int getSkipped() { return skipped; }
        public String getLastError() { return lastError; }
    }
}
