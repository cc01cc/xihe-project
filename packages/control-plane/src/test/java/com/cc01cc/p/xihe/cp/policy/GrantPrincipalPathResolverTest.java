package com.cc01cc.p.xihe.cp.policy;

import com.cc01cc.p.xihe.cp.chat.ChatRunStatusReadService;
import com.cc01cc.p.xihe.cp.entity.ChatRun;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.mcp.McpInvocationService;
import com.cc01cc.p.xihe.cp.service.SessionReadService;
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

        SessionReadService sessionReadService = mock(SessionReadService.class);
        ChatRunStatusReadService chatRunStatusReadService = mock(ChatRunStatusReadService.class);
        McpInvocationService mcpInvocationService = mock(McpInvocationService.class);
        when(mcpInvocationService.findAgentInvocationContext(runId.toString(), toolCallId.toString()))
                .thenReturn(Optional.empty());

        GrantPrincipalPathResolver resolver = new GrantPrincipalPathResolver(
                sessionReadService, chatRunStatusReadService, mcpInvocationService);

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

        SessionReadService sessionReadService = mock(SessionReadService.class);
        ChatRunStatusReadService chatRunStatusReadService = mock(ChatRunStatusReadService.class);
        McpInvocationService mcpInvocationService = mock(McpInvocationService.class);

        Session session = new Session(workspaceId.toString(), userId.toString(), "test");
        session.setId(sessionId);
        session.setAgentPrincipalId(principalId.toString());
        SessionReadService.SessionPathView sessionView = new SessionReadService.SessionPathView(
                session.getId(), session.getUserId(), session.getWorkspaceId(),
                session.getAgentPrincipalId(), session.getSpawnedFromSessionId(),
                session.getSpawnedFromRunId(), session.getSpawnedAt(), session.getKind(),
                session.getAgentPermissionsSnapshot());
        when(sessionReadService.findById(sessionId)).thenReturn(Optional.of(sessionView));

        ChatRun run = new ChatRun(runId.toString(), sessionId.toString(), userId.toString(),
                workspaceId.toString(), "request", "hash", "provider", "model", "workspace", "running");
        ChatRunStatusReadService.ChatRunStatusView runView = new ChatRunStatusReadService.ChatRunStatusView(
                run.getId(), run.getStatus(), run.getSessionId(), run.getUserId(),
                run.getWorkspaceId(), run.getCreatedAt(), run.getUpdatedAt());
        when(chatRunStatusReadService.findById(runId)).thenReturn(Optional.of(runView));

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
        when(mcpInvocationService.findAgentInvocationContext(runId.toString(), toolCallId.toString()))
                .thenReturn(Optional.of(new McpInvocationService.InvocationContextView(
                        invocation.getStatus(), invocation.getSessionId(), invocation.getUserId(),
                        invocation.getWorkspaceId(), invocation.getRunId(), invocation.getToolName())));

        GrantPrincipalPathResolver resolver = new GrantPrincipalPathResolver(
                sessionReadService, chatRunStatusReadService, mcpInvocationService);

        assertEquals(Optional.of(Boolean.TRUE), resolver.validateAgentInvocationContext(
                userId.toString(), workspaceId.toString(), sessionId.toString(), runId.toString(),
                toolCallId.toString(), "read_file"));

        assertThrows(IllegalArgumentException.class, () -> resolver.validateAgentInvocationContext(
                otherUserId.toString(), workspaceId.toString(), sessionId.toString(), runId.toString(),
                toolCallId.toString(), "read_file"));
    }
}
