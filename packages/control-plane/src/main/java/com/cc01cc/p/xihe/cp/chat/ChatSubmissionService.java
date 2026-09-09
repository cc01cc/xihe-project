package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.entity.ChatRun;
import com.cc01cc.p.xihe.cp.entity.File;
import com.cc01cc.p.xihe.cp.entity.Message;
import com.cc01cc.p.xihe.cp.entity.MessageRole;
import com.cc01cc.p.xihe.cp.operation.OperationService;
import com.cc01cc.p.xihe.cp.repository.ChatRunRepository;
import com.cc01cc.p.xihe.cp.repository.FileRepository;
import com.cc01cc.p.xihe.cp.repository.MessageRepository;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Instant;
import java.util.List;

/**
 * Atomic Chat submission boundary for ChatRun, user Message and Ledger root.
 * Agent dispatch starts only after this transaction has committed.
 */
@Service
public class ChatSubmissionService {

    private static final java.time.Duration LEASE_TTL = java.time.Duration.ofMinutes(10);

    private final ChatRunRepository chatRunRepository;
    private final MessageRepository messageRepository;
    private final FileRepository fileRepository;
    private final OperationService operationService;

    public ChatSubmissionService(ChatRunRepository chatRunRepository,
                                 MessageRepository messageRepository,
                                 FileRepository fileRepository,
                                 OperationService operationService) {
        this.chatRunRepository = chatRunRepository;
        this.messageRepository = messageRepository;
        this.fileRepository = fileRepository;
        this.operationService = operationService;
    }

    @Transactional
    public Submission create(String runId, String sessionId, String userId, String workspaceId,
                             String idempotencyKey, String requestHash, String provider,
                             String model, String toolMode, String providerConnectionId,
                             Long connectionRevision, String leaseOwner, String requestId,
                             String content, String attachmentsJson, List<String> attachmentIds) {
        ChatRun chatRun = new ChatRun(
                runId, sessionId, userId, workspaceId, idempotencyKey, requestHash,
                provider, model, toolMode, "accepted");
        chatRun.setLeaseOwner(leaseOwner);
        chatRun.setLeaseExpiresAt(Instant.now().plus(LEASE_TTL));
        chatRun.setProviderConnectionId(providerConnectionId);
        chatRun.setConnectionRevision(connectionRevision);
        chatRunRepository.save(chatRun);

        Message userMessage = new Message(sessionId, MessageRole.USER, content);
        userMessage.setRunId(runId);
        userMessage.setAttachments(attachmentsJson);
        messageRepository.save(userMessage);
        chatRun.setUserMessageId(userMessage.getId().toString());
        chatRunRepository.save(chatRun);

        for (String fileId : attachmentIds) {
            File file = fileRepository.findById(java.util.UUID.fromString(fileId))
                    .orElseThrow(() -> new IllegalStateException("Attachment disappeared during Chat submission"));
            file.setMessageId(userMessage.getId().toString());
            fileRepository.save(file);
        }

        OperationService.OperationStartResult operation = operationService.startOperation(
                userId, sessionId, workspaceId, runId, requestId,
                "chat", "ui", "user", userId, idempotencyKey, "Chat operation");
        return new Submission(chatRun, userMessage, operation);
    }

    public record Submission(ChatRun run, Message userMessage,
                             OperationService.OperationStartResult operation) {}
}
