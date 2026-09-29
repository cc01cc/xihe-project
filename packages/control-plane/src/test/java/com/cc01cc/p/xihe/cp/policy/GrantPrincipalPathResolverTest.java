package com.cc01cc.p.xihe.cp.policy;

import com.cc01cc.p.xihe.cp.config.DbLockTimeout;
import com.cc01cc.p.xihe.cp.entity.ChatRun;
import com.cc01cc.p.xihe.cp.entity.LedgerOperation;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.repository.ChatRunRepository;
import com.cc01cc.p.xihe.cp.repository.LedgerOperationRepository;
import com.cc01cc.p.xihe.cp.repository.OperationItemRepository;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import org.junit.jupiter.api.Test;

import java.util.Optional;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

class GrantPrincipalPathResolverTest {

    @Test
    void interruptedCallerFailsBeforeQueryingForAgentToolCall() {
        UUID userId = UUID.randomUUID();
        UUID workspaceId = UUID.randomUUID();
        UUID sessionId = UUID.randomUUID();
        UUID runId = UUID.randomUUID();
        UUID operationId = UUID.randomUUID();
        UUID toolCallId = UUID.randomUUID();
        UUID principalId = UUID.randomUUID();

        SessionRepository sessions = mock(SessionRepository.class);
        ChatRunRepository runs = mock(ChatRunRepository.class);
        LedgerOperationRepository operations = mock(LedgerOperationRepository.class);
        OperationItemRepository items = mock(OperationItemRepository.class);
        DbLockTimeout dbLockTimeout = mock(DbLockTimeout.class);

        Session session = new Session(workspaceId.toString(), userId.toString(), "test");
        session.setId(sessionId);
        session.setAgentPrincipalId(principalId.toString());
        ChatRun run = new ChatRun(runId.toString(), sessionId.toString(), userId.toString(),
                workspaceId.toString(), "request", "hash", "provider", "model", "workspace", "running");
        LedgerOperation operation = new LedgerOperation();
        operation.setId(operationId);
        operation.setSessionId(sessionId.toString());
        operation.setRunId(runId.toString());
        operation.setUserId(userId.toString());
        operation.setWorkspaceId(workspaceId.toString());

        when(sessions.findById(sessionId)).thenReturn(Optional.of(session));
        when(runs.findById(runId)).thenReturn(Optional.of(run));
        when(operations.findById(operationId)).thenReturn(Optional.of(operation));

        GrantPrincipalPathResolver resolver = new GrantPrincipalPathResolver(
                sessions, runs, operations, items, dbLockTimeout);
        Thread.currentThread().interrupt();
        try {
            assertThrows(IllegalArgumentException.class, () -> resolver.validateAgentToolCallContext(
                    userId.toString(), workspaceId.toString(), sessionId.toString(), runId.toString(),
                    operationId.toString(), toolCallId.toString(), "read_file"));
            assertTrue(Thread.currentThread().isInterrupted(), "validation must preserve the interrupt flag");
            verifyNoInteractions(items, dbLockTimeout);
        } finally {
            Thread.interrupted();
        }
    }
}
