package com.cc01cc.p.xihe.cp.service;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.cc01cc.p.xihe.cp.repository.MessageRepository;

import java.time.Instant;

@Service
public class ExportService {

    private static final Logger logger = LoggerFactory.getLogger(ExportService.class);
    private static final long EXPORT_MAX_SIZE = 500 * 1024 * 1024;

    private final SessionRepository sessionRepository;
    private final MessageRepository messageRepository;
    private final ObjectMapper objectMapper;

    private volatile Instant lastExportTime = Instant.EPOCH;

    public ExportService(SessionRepository sessionRepository,
                         MessageRepository messageRepository,
                         ObjectMapper objectMapper) {
        this.sessionRepository = sessionRepository;
        this.messageRepository = messageRepository;
        this.objectMapper = objectMapper;
    }

    public String exportSettings(String userId) {
        ObjectNode root = objectMapper.createObjectNode();
        root.put("exportedAt", Instant.now().toString());
        root.put("version", "1.0");
        ObjectNode settings = root.putObject("settings");
        settings.put("userId", userId);
        return serialize(root);
    }

    public String exportChats(String userId) {
        checkRateLimit();
        ObjectNode root = objectMapper.createObjectNode();
        root.put("exportedAt", Instant.now().toString());
        ArrayNode chats = root.putArray("chats");
        var sessions = sessionRepository.findByUserIdAndArchivedFalseOrderByCreatedAtDesc(userId);
        for (var session : sessions) {
            ObjectNode s = chats.addObject();
            s.put("id", session.getId());
            s.put("title", session.getTitle());
            s.put("createdAt", session.getCreatedAt().toString());
            ArrayNode msgs = s.putArray("messages");
            var messages = messageRepository.findBySessionIdOrderByCreatedAtAsc(session.getId());
            for (var msg : messages) {
                ObjectNode m = msgs.addObject();
                m.put("role", msg.getRole().name());
                m.put("content", msg.getContent());
                m.put("createdAt", msg.getCreatedAt().toString());
            }
        }
        return serialize(root);
    }

    private void checkRateLimit() {
        Instant now = Instant.now();
        if (now.toEpochMilli() - lastExportTime.toEpochMilli() < 30_000) {
            throw new RuntimeException("Rate limit: once per 30s");
        }
        lastExportTime = now;
    }

    private String serialize(ObjectNode node) {
        try {
            return objectMapper.writerWithDefaultPrettyPrinter().writeValueAsString(node);
        } catch (Exception e) {
            throw new RuntimeException("Serialization failed", e);
        }
    }
}
