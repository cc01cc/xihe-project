package com.cc01cc.p.xihe.cp.chat;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.Mockito;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.test.util.ReflectionTestUtils;

import java.util.Map;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;

/**
 * PLAN-0679 T2.2: the {@code provider_request_fingerprint} relay branch keeps the
 * durable-before-forward contract (design D4): the recorder sees the parsed payload, and the SSE
 * forward still runs — a diagnostics write can never break a run. Any other event name must not
 * touch the recorder.
 */
class ChatControllerProviderFingerprintRelayTest {

    private static final String RUN_ID = "11111111-1111-1111-1111-111111111111";
    private static final String SESSION_ID = "22222222-2222-2222-2222-222222222222";

    private SseEmitterManager sseEmitterManager;
    private ProviderRequestFingerprintRecorder recorder;
    private ChatController controller;

    @BeforeEach
    void setUp() {
        sseEmitterManager = Mockito.mock(SseEmitterManager.class);
        recorder = Mockito.mock(ProviderRequestFingerprintRecorder.class);
        com.cc01cc.p.xihe.cp.mcp.McpRelayToolRecorder mcpRelayToolRecorder =
                Mockito.mock(com.cc01cc.p.xihe.cp.mcp.McpRelayToolRecorder.class);
        controller = new ChatController(
                new ObjectMapper(),
                sseEmitterManager,
                Mockito.mock(ApprovalService.class),
                Mockito.mock(com.cc01cc.p.xihe.cp.context.service.ContextService.class),
                Mockito.mock(ChatSubmissionService.class),
                Mockito.mock(FollowUpQueueService.class),
                Mockito.mock(com.cc01cc.p.xihe.cp.service.SessionService.class),
                Mockito.mock(com.cc01cc.p.xihe.cp.service.AgentPrincipalService.class),
                Mockito.mock(com.cc01cc.p.xihe.cp.service.SessionParticipantService.class),
                Mockito.mock(WakeFanOutService.class),
                Mockito.mock(com.cc01cc.p.xihe.cp.service.ParticipantCapabilityService.class),
                Mockito.mock(com.cc01cc.p.xihe.cp.files.ChatAttachmentService.class),
                Mockito.mock(ChatActiveRunRegistry.class),
                Mockito.mock(com.cc01cc.p.xihe.cp.status.HealthMonitor.class),
                Mockito.mock(com.cc01cc.p.xihe.cp.status.RequestQueue.class),
                Mockito.mock(com.cc01cc.p.xihe.cp.provider.ProviderCredentialLeaseService.class),
                Mockito.mock(com.cc01cc.p.xihe.cp.config.EmbeddingProfileService.class),
                Mockito.mock(com.cc01cc.p.xihe.cp.provider.ApiRequestValidator.class),
                Mockito.mock(com.cc01cc.p.xihe.cp.config.ConfigService.class),
                mcpRelayToolRecorder,
                Mockito.mock(com.cc01cc.p.xihe.cp.mcp.McpToolTimeoutService.class),
                Mockito.mock(com.cc01cc.p.xihe.cp.timeout.ToolTimeoutPolicy.class),
                Mockito.mock(ChatRunCancellationService.class),
                Mockito.mock(ChatRunTerminalService.class),
                Mockito.mock(ChatRunReadService.class),
                Mockito.mock(ChatRunTransportService.class),
                Mockito.mock(SessionMonitorService.class),
                Mockito.mock(ChatRunLifecycleService.class),
                Mockito.mock(MessageReadService.class),
                Mockito.mock(com.cc01cc.p.xihe.cp.context.service.ContextSourceRefreshService.class),
                Mockito.mock(com.cc01cc.p.xihe.cp.usage.UsageCostMapper.class),
                Mockito.mock(com.cc01cc.p.xihe.cp.service.ContextTemplateSourceService.class),
                Mockito.mock(ApplicationEventPublisher.class),
                new com.cc01cc.p.xihe.cp.policy.ResourceGovernor(),
                Mockito.mock(com.cc01cc.p.xihe.cp.context.service.MentionPathResolver.class),
                Mockito.mock(ContextFingerprintRecorder.class),
                Mockito.mock(com.cc01cc.p.xihe.cp.chat.UserQuestionService.class),
                Mockito.mock(com.cc01cc.p.xihe.cp.event.UserChannelPort.class),
                recorder);
    }

    private void relay(String eventName, String payload) {
        ReflectionTestUtils.invokeMethod(controller, "dispatchRelayedEvent", SESSION_ID, eventName,
                payload, RUN_ID, "req-1", "user-1", "ws-1", null);
    }

    @Test
    void fingerprintEventIsRecordedBeforeTheForwardContinues() {
        relay(ProviderRequestFingerprintRecorder.EVENT_NAME,
                "{\"document\":{\"algo\":\"sha256\"},\"request\":{\"model\":\"m\"}}");

        verify(recorder).recordFirstDispatch(
                org.mockito.ArgumentMatchers.argThat(payload -> payload instanceof Map<?, ?> map
                        && map.get("document") instanceof Map<?, ?> document
                        && "sha256".equals(document.get("algo"))),
                eq(RUN_ID));
        // Durable-before-forward: the relay still fans the event out after the write attempt.
        verify(sseEmitterManager).send(eq(SESSION_ID),
                eq(ProviderRequestFingerprintRecorder.EVENT_NAME), any(), any());
    }

    @Test
    void otherEventNamesNeverTouchTheRecorder() {
        relay("token", "{\"content\":\"hi\"}");
        verify(recorder, never()).recordFirstDispatch(any(), anyString());
    }
}
