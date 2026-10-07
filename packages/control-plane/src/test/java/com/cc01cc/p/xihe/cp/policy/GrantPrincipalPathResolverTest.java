package com.cc01cc.p.xihe.cp.policy;

import com.cc01cc.p.xihe.cp.entity.ChatRun;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.repository.ChatRunRepository;
import com.cc01cc.p.xihe.cp.repository.McpInvocationRepository;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import org.junit.jupiter.api.Test;

import java.util.Optional;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

class GrantPrincipalPathResolverTest {

    /**
     * PLAN-0464 T2.2: with no invocation row the verdict is {@link Optional#empty()}
     * and the caller ({@code GrantAuthorizationService}) fails closed — there is no
     * legacy operation/item path left to fall back to.
     */
    @Test
    void missingInvocationYieldsEmptyVerdictWithoutTouchingLegacyLedger() {
        UUID userId = UUID.randomUUID();
        UUID workspaceId = UUID.randomUUID();
        UUID sessionId = UUID.randomUUID();
        UUID runId = UUID.randomUUID();
        UUID toolCallId = UUID.randomUUID();

        SessionRepository sessions = mock(SessionRepository.class);
        ChatRunRepository runs = mock(ChatRunRepository.class);
        McpInvocationRepository invocations = mock(McpInvocationRepository.class);
        when(invocations.findByRunIdAndToolCallIdAndSource(runId.toString(), toolCallId.toString(),
                "agent")).thenReturn(Optional.empty());

        GrantPrincipalPathResolver resolver = new GrantPrincipalPathResolver(
                sessions, runs, invocations);

        assertEquals(Optional.empty(), resolver.validateAgentInvocationContext(
                userId.toString(), workspaceId.toString(), sessionId.toString(), runId.toString(),
                toolCallId.toString(), "read_file"));
    }

    /**
     * PLAN-0463 T1.3 → PLAN-0464 T2.2 (verify V1/V4): an active in-scope
     * invocation authorizes with no operation/item row at all, and a cross-user
     * invocation fails closed.
     */
    @Test
    void activeInScopeInvocationPassesAndCrossUserFailsClosed() {
        UUID userId = UUID.randomUUID();
        UUID otherUserId = UUID.randomUUID();
        UUID workspaceId = UUID.randomUUID();
        UUID sessionId = UUID.randomUUID();
        UUID runId = UUID.randomUUID();
        UUID toolCallId = UUID.randomUUID();
        UUID principalId = UUID.randomUUID();

        SessionRepository sessions = mock(SessionRepository.class);
        ChatRunRepository runs = mock(ChatRunRepository.class);
        McpInvocationRepository invocations = mock(McpInvocationRepository.class);

        Session session = new Session(workspaceId.toString(), userId.toString(), "test");
        session.setId(sessionId);
        session.setAgentPrincipalId(principalId.toString());
        ChatRun run = new ChatRun(runId.toString(), sessionId.toString(), userId.toString(),
                workspaceId.toString(), "request", "hash", "provider", "model", "workspace", "running");
        when(sessions.findById(sessionId)).thenReturn(Optional.of(session));
        when(runs.findById(runId)).thenReturn(Optional.of(run));

        com.cc01cc.p.xihe.cp.entity.McpInvocation invocation =
                new com.cc01cc.p.xihe.cp.entity.McpInvocation();
        invocation.setId(UUID.randomUUID());
        invocation.setRunId(runId.toString());
        invocation.setSessionId(sessionId.toString());
        invocation.setWorkspaceId(workspaceId.toString());
        invocation.setUserId(userId.toString());
        invocation.setToolCallId(toolCallId.toString());
        invocation.setToolName("read_file");
        invocation.setSource("agent");
        invocation.setStatus("active");
        when(invocations.findByRunIdAndToolCallIdAndSource(runId.toString(), toolCallId.toString(),
                "agent")).thenReturn(Optional.of(invocation));

        GrantPrincipalPathResolver resolver = new GrantPrincipalPathResolver(
                sessions, runs, invocations);

        assertEquals(Optional.of(Boolean.TRUE), resolver.validateAgentInvocationContext(
                userId.toString(), workspaceId.toString(), sessionId.toString(), runId.toString(),
                toolCallId.toString(), "read_file"));

        assertThrows(IllegalArgumentException.class, () -> resolver.validateAgentInvocationContext(
                otherUserId.toString(), workspaceId.toString(), sessionId.toString(), runId.toString(),
                toolCallId.toString(), "read_file"));
    }
}
