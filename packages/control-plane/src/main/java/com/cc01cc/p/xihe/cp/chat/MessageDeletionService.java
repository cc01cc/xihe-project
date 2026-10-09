package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.entity.Message;
import com.cc01cc.p.xihe.cp.files.ChatAttachmentService;
import com.cc01cc.p.xihe.cp.repository.MessageRepository;
import com.cc01cc.p.xihe.cp.service.SessionService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.UUID;

/** Owns the Session-serialized message deletion transaction. */
@Service
public class MessageDeletionService {

    private static final Logger logger = LoggerFactory.getLogger(MessageDeletionService.class);

    private final MessageRepository messageRepository;
    private final ChatAttachmentService chatAttachmentService;
    private final SessionService sessionService;

    public MessageDeletionService(MessageRepository messageRepository,
                                  ChatAttachmentService chatAttachmentService,
                                  SessionService sessionService) {
        this.messageRepository = messageRepository;
        this.chatAttachmentService = chatAttachmentService;
        this.sessionService = sessionService;
    }

    @Transactional
    public String delete(String sessionId, String messageId, String userId, String workspaceId) {
        sessionService.lockCurrentForMutation(sessionId, userId, workspaceId);
        Message message = messageRepository.findById(UUID.fromString(messageId)).orElse(null);
        if (message == null || !sessionId.equals(message.getSessionId())) {
            throw new CpApiException(HttpStatus.NOT_FOUND, "MESSAGE_NOT_FOUND", "Message not found");
        }
        messageRepository.delete(message);
        chatAttachmentService.detachMessageFiles(messageId);
        logger.info("Message deleted session={} messageId={} userId={}", sessionId, messageId, userId);
        return messageId;
    }
}
