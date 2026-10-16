package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.entity.ChatRun;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.service.SessionService;
import com.cc01cc.p.xihe.cp.status.CircuitBreaker;
import com.cc01cc.p.xihe.cp.status.HealthMonitor;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.Mockito;
import org.springframework.context.ApplicationEventPublisher;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class ChatControllerContinuationDispatchTest {
    private static final String RUN_ID = "11111111-1111-1111-1111-111111111111";
    private static final String SOURCE_RUN_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    private static final String SESSION_ID = "22222222-2222-2222-2222-222222222222";
    private static final String USER_ID = "33333333-3333-3333-3333-333333333333";
    private static final String WORKSPACE_ID = "44444444-4444-4444-4444-444444444444";

    private ChatRunReadService chatRunReadService;
    private ChatActiveRunRegistry activeRunRegistry;
    private ChatRunLifecycleService chatRunLifecycleService;
    private SessionService sessionService;
    private ChatController controller;

    @BeforeEach
    void setUp() {
        chatRunReadService = Mockito.mock(ChatRunReadService.class);
        MessageReadService messageReadService = Mockito.mock(MessageReadService.class);
        sessionService = Mockito.mock(SessionService.class);
        activeRunRegistry = Mockito.mock(ChatActiveRunRegistry.class);
        chatRunLifecycleService = Mockito.mock(ChatRunLifecycleService.class);
        HealthMonitor healthMonitor = Mockito.mock(HealthMonitor.class);
        when(healthMonitor.getAgentBreaker()).thenReturn(Mockito.mock(CircuitBreaker.class));
        controller = new ChatController(
                new ObjectMapper(),
                Mockito.mock(SseEmitterManager.class),
                Mockito.mock(ApprovalService.class),
                Mockito.mock(com.cc01cc.p.xihe.cp.context.service.ContextService.class),
                Mockito.mock(ChatSubmissionService.class),
                Mockito.mock(FollowUpQueueService.class),
                sessionService,
                Mockito.mock(com.cc01cc.p.xihe.cp.service.AgentPrincipalService.class),
                Mockito.mock(com.cc01cc.p.xihe.cp.files.ChatAttachmentService.class),
                activeRunRegistry,
                healthMonitor,
                Mockito.mock(com.cc01cc.p.xihe.cp.status.RequestQueue.class),
                Mockito.mock(com.cc01cc.p.xihe.cp.provider.ProviderCredentialLeaseService.class),
                Mockito.mock(com.cc01cc.p.xihe.cp.config.EmbeddingProfileService.class),
                Mockito.mock(com.cc01cc.p.xihe.cp.provider.ApiRequestValidator.class),
                Mockito.mock(com.cc01cc.p.xihe.cp.config.ConfigService.class),
                Mockito.mock(com.cc01cc.p.xihe.cp.mcp.McpRelayToolRecorder.class),
                Mockito.mock(com.cc01cc.p.xihe.cp.mcp.McpToolTimeoutService.class),
                Mockito.mock(com.cc01cc.p.xihe.cp.timeout.ToolTimeoutPolicy.class),
                Mockito.mock(ChatRunCancellationService.class),
                Mockito.mock(ChatRunTerminalService.class),
                chatRunReadService,
                Mockito.mock(ChatRunTransportService.class),
                Mockito.mock(SessionMonitorService.class),
                chatRunLifecycleService,
                messageReadService,
                Mockito.mock(com.cc01cc.p.xihe.cp.context.service.ContextSourceRefreshService.class),
                Mockito.mock(com.cc01cc.p.xihe.cp.usage.UsageCostMapper.class),
                Mockito.mock(com.cc01cc.p.xihe.cp.service.ContextTemplateSourceService.class),
                Mockito.mock(ApplicationEventPublisher.class));
    }

    @Test
    void duplicateContinuationEventCannotAcquireAnotherSessionDispatchSlot() {
        ChatRunReadService.ContinuationDescriptor checkpoint = new ChatRunReadService.ContinuationDescriptor(
                ChatRunContinuationRequest.RESUME_PENDING, SOURCE_RUN_ID,
                UUID.randomUUID().toString(), UUID.randomUUID().toString(), "checkpoint-7", 7L,
                UUID.randomUUID().toString());
        ChatRunReadService.ContinuationDispatchRun run = new ChatRunReadService.ContinuationDispatchRun(
                RUN_ID, SESSION_ID, USER_ID, WORKSPACE_ID, ChatRun.ORIGIN_USER_SUBMISSION,
                "accepted", null, "provider", "model", "workspace", checkpoint);
        when(chatRunReadService.findContinuationDispatchRun(RUN_ID)).thenReturn(Optional.of(run));
        when(sessionService.requireCurrent(SESSION_ID, USER_ID, WORKSPACE_ID))
                .thenReturn(new Session(WORKSPACE_ID, USER_ID, "target"));
        when(activeRunRegistry.putIfAbsent(SESSION_ID, RUN_ID)).thenReturn("already-active-run");

        assertFalse(controller.dispatchContinuationRun(
                new ContinuationRunDispatchRequestedEvent(SOURCE_RUN_ID, RUN_ID, List.of("tool-call"))));

        verify(chatRunLifecycleService, never()).tryAcquireLease(
                eq(UUID.fromString(RUN_ID)), anyString(), any(java.time.Instant.class), any(java.time.Instant.class));
    }

    @Test
    void runningContinuationIsNeverRedispatchedFromAnIdempotentEvent() {
        ChatRunReadService.ContinuationDescriptor checkpoint = new ChatRunReadService.ContinuationDescriptor(
                ChatRunContinuationRequest.RESUME_PENDING, SOURCE_RUN_ID,
                UUID.randomUUID().toString(), UUID.randomUUID().toString(), "checkpoint-7", 7L,
                UUID.randomUUID().toString());
        when(chatRunReadService.findContinuationDispatchRun(RUN_ID)).thenReturn(Optional.of(
                new ChatRunReadService.ContinuationDispatchRun(RUN_ID, SESSION_ID, USER_ID, WORKSPACE_ID,
                        ChatRun.ORIGIN_USER_SUBMISSION, "running", null, "provider", "model", "workspace", checkpoint)));

        assertFalse(controller.dispatchContinuationRun(
                new ContinuationRunDispatchRequestedEvent(SOURCE_RUN_ID, RUN_ID, List.of("tool-call"))));

        verify(sessionService, never()).requireCurrent(anyString(), anyString(), anyString());
        verify(activeRunRegistry, never()).putIfAbsent(anyString(), anyString());
    }
}
