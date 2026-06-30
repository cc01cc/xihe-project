package com.cc01cc.p.xihe.cp.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import com.cc01cc.p.xihe.cp.entity.Message;
import com.cc01cc.p.xihe.cp.entity.MessageRole;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.cc01cc.p.xihe.cp.repository.MessageRepository;

import java.time.Instant;

@Service
public class ImportService {

    private static final Logger logger = LoggerFactory.getLogger(ImportService.class);
    private static final long IMPORT_MAX_SIZE = 500 * 1024 * 1024;

    private final SessionRepository sessionRepository;
    private final MessageRepository messageRepository;
    private final ObjectMapper objectMapper;

    public ImportService(SessionRepository sessionRepository,
                         MessageRepository messageRepository,
                         ObjectMapper objectMapper) {
        this.sessionRepository = sessionRepository;
        this.messageRepository = messageRepository;
        this.objectMapper = objectMapper;
    }

    @Transactional
    public ImportResult importChats(String json, String userId) {
        ImportResult result = new ImportResult();
        try {
            JsonNode root = objectMapper.readTree(json);
            JsonNode chats = root.get("chats");
            if (chats == null || !chats.isArray()) {
                result.addError("Invalid format: missing 'chats' array");
                return result;
            }
            for (JsonNode chat : chats) {
                String id = chat.get("id").asText();
                if (sessionRepository.existsById(id)) {
                    result.addSkipped(id);
                    continue;
                }
                Session session = new Session();
                session.setId(id);
                session.setUserId(userId);
                session.setTitle(chat.get("title").asText("Imported"));
                session.setCreatedAt(Instant.parse(chat.get("createdAt").asText()));
                session.setArchived(false);
                sessionRepository.save(session);
                result.addImported(id);

                JsonNode msgs = chat.get("messages");
                if (msgs != null) {
                    for (JsonNode m : msgs) {
                        Message msg = new Message();
                        msg.setSessionId(id);
                        msg.setRole(MessageRole.valueOf(m.get("role").asText().toUpperCase()));
                        msg.setContent(m.get("content").asText());
                        msg.setCreatedAt(Instant.parse(m.get("createdAt").asText()));
                        messageRepository.save(msg);
                    }
                }
            }
        } catch (Exception e) {
            logger.error("Import failed", e);
            result.addError(e.getMessage());
        }
        return result;
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
