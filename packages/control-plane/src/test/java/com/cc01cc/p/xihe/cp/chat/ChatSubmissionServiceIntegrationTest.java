package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.AbstractIntegrationTest;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.entity.UserRole;
import com.cc01cc.p.xihe.cp.entity.Workspace;
import com.cc01cc.p.xihe.cp.operation.OperationService;
import com.cc01cc.p.xihe.cp.repository.ChatRunRepository;
import com.cc01cc.p.xihe.cp.repository.MessageRepository;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceRepository;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.test.context.bean.override.mockito.MockitoBean;

import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.doThrow;

class ChatSubmissionServiceIntegrationTest extends AbstractIntegrationTest {

    @Autowired
    private ChatSubmissionService submissionService;

    @Autowired
    private UserRepository userRepository;

    @Autowired
    private WorkspaceRepository workspaceRepository;

    @Autowired
    private SessionRepository sessionRepository;

    @Autowired
    private ChatRunRepository chatRunRepository;

    @Autowired
    private MessageRepository messageRepository;

    @MockitoBean
    private OperationService operationService;

    @Test
    void operationFailureRollsBackChatRunAndUserMessage() {
        User user = userRepository.save(new User(
                "chat-submit-" + UUID.randomUUID() + "@test.com", "hash", UserRole.USER, "Chat Submit"));
        Workspace workspace = workspaceRepository.save(new Workspace("Chat Submit Workspace", user.getId().toString()));
        Session session = new Session(workspace.getId().toString(), user.getId().toString(), "Chat Submit Session");
        session.setId(UUID.randomUUID());
        Session persistedSession = sessionRepository.save(session);

        String runId = UUID.randomUUID().toString();
        doThrow(new IllegalStateException("forced Ledger failure"))
                .when(operationService)
                .startOperation(any(), any(), any(), any(), any(), any(), any(), any(), any(), any(), any());

        assertThrows(IllegalStateException.class, () -> submissionService.create(
                runId,
                persistedSession.getId().toString(),
                user.getId().toString(),
                workspace.getId().toString(),
                "idem-" + UUID.randomUUID(),
                "request-hash",
                "provider",
                "model",
                "none",
                null,
                null,
                "lease-owner",
                UUID.randomUUID().toString(),
                "message",
                "[]",
                java.util.List.of()));

        assertTrue(chatRunRepository.findById(UUID.fromString(runId)).isEmpty());
        assertTrue(messageRepository.findBySessionIdOrderByCreatedAtAsc(persistedSession.getId().toString()).isEmpty());
    }
}
