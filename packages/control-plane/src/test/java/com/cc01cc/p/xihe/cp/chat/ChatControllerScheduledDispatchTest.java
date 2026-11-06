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

import java.util.Optional;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * PLAN-0489 决策 #7：dispatchScheduledRun 的 headless handoff 契约——origin=
 * scheduled + accepted 的 Run 在普通会话上完成 lease/registry 交接并进入
 * execAsync；origin/状态不符直接 false；不复用 dispatchSpawnRun 的 KIND_SPAWN
 * 会话门。
 */
class ChatControllerScheduledDispatchTest {

    private static final String RUN_ID = "11111111-1111-1111-1111-111111111111";
    private static final String SESSION_ID = "22222222-2222-2222-2222-222222222222";
    private static final String USER_ID = "33333333-3333-3333-3333-333333333333";
    private static final String WORKSPACE_ID = "44444444-4444-4444-4444-444444444444";
    private static final String MESSAGE_ID = "55555555-5555-5555-5555-555555555555";

    private ChatRunReadService chatRunReadService;
    private MessageReadService messageReadService;
    private SessionService sessionService;
    private ChatActiveRunRegistry activeRunRegistry;
    private ChatRunLifecycleService chatRunLifecycleService;
    private ChatController controller;

    @BeforeEach
    void setUp() {
        chatRunReadService = Mockito.mock(ChatRunReadService.class);
        messageReadService = Mockito.mock(MessageReadService.class);
        sessionService = Mockito.mock(SessionService.class);
        activeRunRegistry = Mockito.mock(ChatActiveRunRegistry.class);
        // PLAN-0645: the registry claim is idempotent per run; the success path needs it to win.
        when(activeRunRegistry.claim(anyString(), anyString())).thenReturn(true);
        chatRunLifecycleService = Mockito.mock(ChatRunLifecycleService.class);
        ChatRunCancellationService cancellationService = Mockito.mock(ChatRunCancellationService.class);
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
                Mockito.mock(com.cc01cc.p.xihe.cp.service.SessionParticipantService.class),
                Mockito.mock(WakeFanOutService.class),
                Mockito.mock(com.cc01cc.p.xihe.cp.service.ParticipantCapabilityService.class),
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
                cancellationService,
                Mockito.mock(ChatRunTerminalService.class),
                chatRunReadService,
                Mockito.mock(ChatRunTransportService.class),
                Mockito.mock(SessionMonitorService.class),
                chatRunLifecycleService,
                messageReadService,
                Mockito.mock(com.cc01cc.p.xihe.cp.context.service.ContextSourceRefreshService.class),
                Mockito.mock(com.cc01cc.p.xihe.cp.usage.UsageCostMapper.class),
                Mockito.mock(com.cc01cc.p.xihe.cp.service.ContextTemplateSourceService.class),
                Mockito.mock(ApplicationEventPublisher.class),
                new com.cc01cc.p.xihe.cp.policy.ResourceGovernor(),
                Mockito.mock(com.cc01cc.p.xihe.cp.context.service.MentionPathResolver.class),
                Mockito.mock(ContextFingerprintRecorder.class),
                Mockito.mock(com.cc01cc.p.xihe.cp.chat.UserQuestionService.class),
                Mockito.mock(com.cc01cc.p.xihe.cp.event.UserChannelPort.class),
                Mockito.mock(ProviderRequestFingerprintRecorder.class));
    }

    private static ChatRunReadService.DispatchRun scheduledRun(String origin, String status) {
        return new ChatRunReadService.DispatchRun(RUN_ID, SESSION_ID, USER_ID, WORKSPACE_ID,
                origin, status, MESSAGE_ID, "provider", "model", "none");
    }

    private void stubCommittedScheduledRun(ChatRunReadService.DispatchRun run, Session session) {
        when(chatRunReadService.findDispatchRun(RUN_ID)).thenReturn(Optional.of(run));
        when(sessionService.requireCurrent(SESSION_ID, USER_ID, WORKSPACE_ID)).thenReturn(session);
        when(messageReadService.findDispatchMessage(MESSAGE_ID)).thenReturn(Optional.of(
                new MessageReadService.DispatchMessage(SESSION_ID, RUN_ID, "wake up now", "[]")));
        when(chatRunLifecycleService.tryAcquireLease(any(UUID.class), anyString(),
                any(java.time.Instant.class), any(java.time.Instant.class))).thenReturn(1);
    }

    @Test
    void scheduled_run_on_normal_session_completes_lease_handoff() {
        Session normalSession = new Session(WORKSPACE_ID, USER_ID, "normal target");
        stubCommittedScheduledRun(scheduledRun(ChatRun.ORIGIN_SCHEDULED, "accepted"), normalSession);

        assertTrue(controller.dispatchScheduledRun(RUN_ID));

        verify(activeRunRegistry).claim(SESSION_ID, RUN_ID);
        verify(chatRunLifecycleService).tryAcquireLease(eq(UUID.fromString(RUN_ID)), anyString(),
                any(java.time.Instant.class), any(java.time.Instant.class));
    }

    @Test
    void spawn_kind_session_is_not_rejected_by_scheduled_dispatch() {
        Session spawnSession = new Session(WORKSPACE_ID, USER_ID, "spawn target");
        spawnSession.setKind(Session.KIND_SPAWN);
        stubCommittedScheduledRun(scheduledRun(ChatRun.ORIGIN_SCHEDULED, "accepted"), spawnSession);

        assertTrue(controller.dispatchScheduledRun(RUN_ID));

        verify(activeRunRegistry).claim(SESSION_ID, RUN_ID);
        verify(chatRunLifecycleService).tryAcquireLease(eq(UUID.fromString(RUN_ID)), anyString(),
                any(java.time.Instant.class), any(java.time.Instant.class));
    }

    @Test
    void non_scheduled_origin_is_rejected_before_handoff() {
        when(chatRunReadService.findDispatchRun(RUN_ID)).thenReturn(Optional.of(
                scheduledRun(ChatRun.ORIGIN_USER_SUBMISSION, "accepted")));

        assertFalse(controller.dispatchScheduledRun(RUN_ID));

        verify(activeRunRegistry, never()).claim(anyString(), anyString());
        verify(sessionService, never()).requireCurrent(anyString(), anyString(), anyString());
    }

    @Test
    void non_accepted_status_is_rejected_before_handoff() {
        when(chatRunReadService.findDispatchRun(RUN_ID)).thenReturn(Optional.of(
                scheduledRun(ChatRun.ORIGIN_SCHEDULED, "running")));

        assertFalse(controller.dispatchScheduledRun(RUN_ID));

        verify(activeRunRegistry, never()).claim(anyString(), anyString());
    }

    @Test
    void unknown_run_is_rejected_before_handoff() {
        when(chatRunReadService.findDispatchRun(RUN_ID)).thenReturn(Optional.empty());

        assertFalse(controller.dispatchScheduledRun(RUN_ID));

        verify(activeRunRegistry, never()).claim(anyString(), anyString());
    }

    @Test
    void missing_user_message_is_refused_with_a_reason_instead_of_throwing() {
        // PLAN-0630 M5b / D2: the old contract threw from inside the event listener, which left the
        // committed Run in "accepted" with no owner. A refusal now names its branch.
        Session normalSession = new Session(WORKSPACE_ID, USER_ID, "normal target");
        when(chatRunReadService.findDispatchRun(RUN_ID)).thenReturn(Optional.of(
                scheduledRun(ChatRun.ORIGIN_SCHEDULED, "accepted")));
        when(sessionService.requireCurrent(SESSION_ID, USER_ID, WORKSPACE_ID)).thenReturn(normalSession);
        when(messageReadService.findDispatchMessage(MESSAGE_ID)).thenReturn(Optional.empty());

        ChatController.DispatchOutcome outcome = controller.dispatchScheduledRunDetailed(RUN_ID);

        assertFalse(outcome.dispatched());
        assertEquals("user_message_mismatch", outcome.reason());
        verify(activeRunRegistry, never()).claim(anyString(), anyString());
    }

    @Test
    void already_claimed_run_is_refused_with_its_branch() {
        Session normalSession = new Session(WORKSPACE_ID, USER_ID, "normal target");
        stubCommittedScheduledRun(scheduledRun(ChatRun.ORIGIN_SCHEDULED, "accepted"), normalSession);
        when(activeRunRegistry.claim(SESSION_ID, RUN_ID)).thenReturn(false);

        ChatController.DispatchOutcome outcome = controller.dispatchScheduledRunDetailed(RUN_ID);

        assertFalse(outcome.dispatched());
        assertEquals("already_claimed", outcome.reason());
        verify(chatRunLifecycleService, never()).tryAcquireLease(any(UUID.class), anyString(),
                any(java.time.Instant.class), any(java.time.Instant.class));
    }

    @Test
    void lease_refusal_releases_the_claim_and_names_the_branch() {
        Session normalSession = new Session(WORKSPACE_ID, USER_ID, "normal target");
        stubCommittedScheduledRun(scheduledRun(ChatRun.ORIGIN_SCHEDULED, "accepted"), normalSession);
        when(chatRunLifecycleService.tryAcquireLease(any(UUID.class), anyString(),
                any(java.time.Instant.class), any(java.time.Instant.class))).thenReturn(0);

        ChatController.DispatchOutcome outcome = controller.dispatchScheduledRunDetailed(RUN_ID);

        assertFalse(outcome.dispatched());
        assertEquals("lease_not_acquired", outcome.reason());
        verify(activeRunRegistry).release(SESSION_ID, RUN_ID);
    }

    @Test
    void status_refusal_names_the_observed_status() {
        when(chatRunReadService.findDispatchRun(RUN_ID)).thenReturn(Optional.of(
                scheduledRun(ChatRun.ORIGIN_SCHEDULED, "running")));

        ChatController.DispatchOutcome outcome = controller.dispatchScheduledRunDetailed(RUN_ID);

        assertFalse(outcome.dispatched());
        assertEquals("status_not_dispatchable:running", outcome.reason());
    }

    @Test
    void listener_terminalizes_a_refused_run_so_it_never_stays_accepted() {
        // The defect that blocked PLAN-0630 T5b.4: dispatched=false used to leave the Run accepted
        // for ever. The listener owns the committed Run, so it must terminalize it.
        Session normalSession = new Session(WORKSPACE_ID, USER_ID, "normal target");
        stubCommittedScheduledRun(scheduledRun(ChatRun.ORIGIN_SCHEDULED, "accepted"), normalSession);
        when(activeRunRegistry.claim(SESSION_ID, RUN_ID)).thenReturn(false);

        controller.onScheduledRunDispatchRequested(
                new ScheduledRunDispatchRequestedEvent(SESSION_ID, RUN_ID));

        verify(chatRunLifecycleService).transition(RUN_ID, java.util.List.of("accepted"), "failed",
                "dispatch_refused", "SCHEDULED_DISPATCH_REFUSED", "already_claimed", 0, 0, null);
        verify(chatRunLifecycleService).releaseLease(eq(UUID.fromString(RUN_ID)), anyString());
    }

    @Test
    void listener_leaves_a_dispatched_run_alone() {
        Session normalSession = new Session(WORKSPACE_ID, USER_ID, "normal target");
        stubCommittedScheduledRun(scheduledRun(ChatRun.ORIGIN_SCHEDULED, "accepted"), normalSession);

        controller.onScheduledRunDispatchRequested(
                new ScheduledRunDispatchRequestedEvent(SESSION_ID, RUN_ID));

        // execAsync itself fails in this harness (no Agent endpoint), so the only assertion that
        // matters here is: no *refusal* terminalization was written for a Run that WAS dispatched.
        verify(chatRunLifecycleService, never()).transition(anyString(), any(),
                anyString(), eq("dispatch_refused"), any(), any(), anyInt(), anyInt(), any());
    }
}
