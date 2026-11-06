package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.checkpoint.AgentGraphCheckpointService;
import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.config.DbLockTimeout;
import com.cc01cc.p.xihe.cp.entity.ChatRun;
import com.cc01cc.p.xihe.cp.entity.Message;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.mcp.LineageInvocationService;
import com.cc01cc.p.xihe.cp.repository.ChatRunRepository;
import com.cc01cc.p.xihe.cp.repository.MessageRepository;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.fasterxml.jackson.databind.ObjectMapper;
import ch.qos.logback.classic.Logger;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.core.read.ListAppender;
import jakarta.persistence.EntityManager;
import org.slf4j.LoggerFactory;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.ArgumentCaptor;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.context.ApplicationEventPublisher;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

@ExtendWith(MockitoExtension.class)
class ChatRunContinuationServiceTest {
    private static final String USER_ID = UUID.randomUUID().toString();
    private static final String WORKSPACE_ID = UUID.randomUUID().toString();
    private static final String SESSION_ID = UUID.randomUUID().toString();
    private static final String SOURCE_RUN_ID = UUID.randomUUID().toString();
    private static final String BRANCH_ID = UUID.randomUUID().toString();
    private static final String LINEAGE_ID = UUID.randomUUID().toString();
    private static final String THREAD_ID = UUID.randomUUID().toString();
    private static final String CHECKPOINT_ID = "checkpoint-7";

    @Mock private ChatRunRepository runs;
    @Mock private SessionRepository sessions;
    @Mock private MessageRepository messages;
    @Mock private AgentGraphCheckpointService checkpoints;
    @Mock private LineageInvocationService lineageInvocations;
    @Mock private ContinuationRuntimeJobGate runtimeJobGate;
    @Mock private DbLockTimeout dbLockTimeout;
    @Mock private EntityManager entityManager;
    @Mock private ApplicationEventPublisher eventPublisher;
    /** PLAN-0645 D45-01: the bounded-concurrency gate (void requireSlot is a no-op on a mock). */
    @Mock private SessionRunConcurrencyGate runConcurrencyGate;

    private ChatRun source;
    private Session session;
    private ChatRunContinuationService service;

    @BeforeEach
    void setUp() {
        source = new ChatRun(SOURCE_RUN_ID, SESSION_ID, USER_ID, WORKSPACE_ID,
                "source-key", "source-hash", "provider", "model", "workspace", "ambiguous");
        source.setBranchId(BRANCH_ID);
        source.setErrorCode("CP_RESTARTED");

        session = new Session(WORKSPACE_ID, USER_ID, "continuation test");
        session.setId(UUID.fromString(SESSION_ID));

        when(runs.findById(UUID.fromString(SOURCE_RUN_ID))).thenReturn(Optional.of(source));
        when(sessions.findByIdForUpdate(UUID.fromString(SESSION_ID))).thenReturn(Optional.of(session));
        when(runs.findByIdForUpdate(UUID.fromString(SOURCE_RUN_ID))).thenReturn(Optional.of(source));
        when(runs.findByUserIdAndSessionIdAndIdempotencyKey(USER_ID, SESSION_ID, "continuation-key"))
                .thenReturn(Optional.empty());

        service = new ChatRunContinuationService(runs, sessions, messages, checkpoints,
                lineageInvocations, runtimeJobGate, dbLockTimeout, entityManager,
                new ObjectMapper(), eventPublisher, runConcurrencyGate);
    }

    /**
     * PLAN-0628 M2a (D28-39 ②): the child inherits the parent's frozen listing instead of resolving a
     * fresh one — a binding added while the parent ran must not appear in the continuation, and the
     * record says so via {@code snapshotSource=inherited}.
     */
    @Test
    void childInheritsTheParentSkillsSnapshotInsteadOfResolvingAFreshOne() throws Exception {
        stubNewChildCreation();
        source.setSkillsSnapshot(new ObjectMapper().readTree(
                "{\"version\":1,\"status\":\"ready\",\"source\":\"skill_bindings\","
                        + "\"snapshotSource\":\"frozen\",\"maxSkills\":40,\"truncated\":false,"
                        + "\"diagnostics\":[],\"items\":[{\"name\":\"alpha\"}]}"));

        service.continueRun(SOURCE_RUN_ID, USER_ID, WORKSPACE_ID, "continuation-key",
                new ChatRunContinuationRequest(ChatRunContinuationRequest.RESUME_PENDING, null));

        ChatRun child = savedChild();
        assertEquals("inherited", child.getSkillsSnapshot().path("snapshotSource").asText());
        assertEquals(source.getSkillsSnapshot().path("items"), child.getSkillsSnapshot().path("items"));
        assertEquals("alpha", child.getSkillsSnapshot().path("items").get(0).path("name").asText());
        assertEquals("frozen", source.getSkillsSnapshot().path("snapshotSource").asText(),
                "inheritance must not rewrite the parent record");
    }

    @Test
    void resumePendingCreatesProvenancedChildAndLeavesSourceTerminal() {
        stubNewChildCreation();
        ChatRunContinuationService.ContinuationResult result = service.continueRun(
                SOURCE_RUN_ID, USER_ID, WORKSPACE_ID, "continuation-key",
                new ChatRunContinuationRequest(ChatRunContinuationRequest.RESUME_PENDING, null));

        ChatRun child = savedChild();
        assertEquals(ChatRun.ORIGIN_USER_SUBMISSION, child.getOrigin());
        assertEquals("accepted", child.getStatus());
        assertEquals(SOURCE_RUN_ID, child.getContinuationSourceRunId());
        assertEquals(LINEAGE_ID, child.getContinuationLineageId());
        assertEquals(THREAD_ID, child.getContinuationThreadId());
        assertEquals(CHECKPOINT_ID, child.getContinuationCheckpointId());
        assertEquals(7L, child.getContinuationEventSequence());
        assertEquals(ChatRunContinuationRequest.RESUME_PENDING, child.getContinuationMode());
        assertEquals(BRANCH_ID, child.getBranchId());
        assertEquals(child.getId().toString(), result.runId());
        assertEquals(ChatRunContinuationRequest.RESUME_PENDING, result.mode());
        assertFalse(result.replayed());
        assertEquals("ambiguous", source.getStatus());
        assertEquals("CP_RESTARTED", source.getErrorCode());
        verify(messages, never()).save(any(Message.class));

        ArgumentCaptor<ContinuationRunDispatchRequestedEvent> event =
                ArgumentCaptor.forClass(ContinuationRunDispatchRequestedEvent.class);
        verify(eventPublisher).publishEvent(event.capture());
        assertEquals(List.of("origin-call-1"), event.getValue().completedToolCallIds());
    }

    @Test
    void appendUserTurnPersistsExactlyOneMessageForTheChild() {
        stubNewChildCreation();
        when(messages.save(any(Message.class))).thenAnswer(invocation -> {
            Message message = invocation.getArgument(0);
            message.setId(UUID.randomUUID());
            return message;
        });
        when(runs.save(any(ChatRun.class))).thenAnswer(invocation -> invocation.getArgument(0));
        ChatRunContinuationService.ContinuationResult result = service.continueRun(
                SOURCE_RUN_ID, USER_ID, WORKSPACE_ID, "continuation-key",
                new ChatRunContinuationRequest(ChatRunContinuationRequest.APPEND_USER_TURN, "continue from here"));

        ChatRun child = savedChild();
        ArgumentCaptor<Message> message = ArgumentCaptor.forClass(Message.class);
        verify(messages).save(message.capture());
        assertEquals("continue from here", message.getValue().getContent());
        assertEquals(SESSION_ID, message.getValue().getSessionId());
        assertEquals(child.getId().toString(), message.getValue().getRunId());
        assertEquals(BRANCH_ID, message.getValue().getBranchId());
        assertEquals(message.getValue().getId().toString(), child.getUserMessageId());
        assertEquals(ChatRunContinuationRequest.APPEND_USER_TURN, result.mode());
        assertTrue(child.getUserMessageId() != null);
    }

    @Test
    void staleBranchCursorRejectsBeforeCreatingChild() {
        when(checkpoints.findLatestSafeCheckpointForSourceRun(eq(SOURCE_RUN_ID), any()))
                .thenReturn(new AgentGraphCheckpointService.ContinuationCheckpointView(
                        LINEAGE_ID, THREAD_ID, CHECKPOINT_ID, 6,
                        SESSION_ID, USER_ID, WORKSPACE_ID, BRANCH_ID, 1, "0.1.0", 7));

        CpApiException error = assertThrows(CpApiException.class, () -> service.continueRun(
                SOURCE_RUN_ID, USER_ID, WORKSPACE_ID, "continuation-key",
                new ChatRunContinuationRequest(ChatRunContinuationRequest.RESUME_PENDING, null)));

        assertEquals("CONTINUATION_SOURCE_STALE", error.getCode());
        verify(runs, never()).saveAndFlush(any(ChatRun.class));
        verify(lineageInvocations, never()).requireContinuationEligible(any(), any());
        verify(eventPublisher, never()).publishEvent(any(Object.class));
    }

    @Test
    void rejectsSourceStatusOutsideFrozenRecoveryState() {
        source.setStatus("succeeded");

        CpApiException error = assertThrows(CpApiException.class, () -> service.continueRun(
                SOURCE_RUN_ID, USER_ID, WORKSPACE_ID, "continuation-key",
                new ChatRunContinuationRequest(ChatRunContinuationRequest.RESUME_PENDING, null)));

        assertEquals("CONTINUATION_SOURCE_INELIGIBLE", error.getCode());
        verify(checkpoints, never()).findLatestSafeCheckpointForSourceRun(any(), any());
        verify(runs, never()).saveAndFlush(any(ChatRun.class));
    }

    @Test
    void idempotentReplayOfAnAlreadyStartedChildDoesNotRecheckOrRedispatchIt() {
        ChatRunContinuationRequest request =
                new ChatRunContinuationRequest(ChatRunContinuationRequest.RESUME_PENDING, null);
        String requestHash = ChatRunContinuationHash.calculate(
                new ObjectMapper(), USER_ID, WORKSPACE_ID, SESSION_ID, SOURCE_RUN_ID, request, BRANCH_ID);
        String existingId = UUID.randomUUID().toString();
        ChatRun existing = continuationChild(existingId, requestHash, request.mode(), "running");
        when(runs.findByUserIdAndSessionIdAndIdempotencyKey(USER_ID, SESSION_ID, "continuation-key"))
                .thenReturn(Optional.of(existing));

        ChatRunContinuationService.ContinuationResult result = service.continueRun(
                SOURCE_RUN_ID, USER_ID, WORKSPACE_ID, "continuation-key", request);

        assertEquals(existingId, result.runId());
        assertTrue(result.replayed());
        verify(lineageInvocations, never()).requireContinuationEligible(any(), any());
        verify(runtimeJobGate, never()).requireEligible(any(), any());
        verify(eventPublisher, never()).publishEvent(any(Object.class));
        verify(runs, never()).saveAndFlush(any(ChatRun.class));
    }

    @Test
    void acceptedChildReplayRevalidatesCheckpointFreshnessBeforeRedispatch() {
        ChatRunContinuationRequest request =
                new ChatRunContinuationRequest(ChatRunContinuationRequest.RESUME_PENDING, null);
        String requestHash = ChatRunContinuationHash.calculate(
                new ObjectMapper(), USER_ID, WORKSPACE_ID, SESSION_ID, SOURCE_RUN_ID, request, BRANCH_ID);
        ChatRun existing = continuationChild(UUID.randomUUID().toString(), requestHash, request.mode(), "accepted");
        when(runs.findByUserIdAndSessionIdAndIdempotencyKey(USER_ID, SESSION_ID, "continuation-key"))
                .thenReturn(Optional.of(existing));
        when(checkpoints.findLatestSafeCheckpointForSourceRun(eq(SOURCE_RUN_ID), any()))
                .thenReturn(new AgentGraphCheckpointService.ContinuationCheckpointView(
                        LINEAGE_ID, THREAD_ID, CHECKPOINT_ID, 6,
                        SESSION_ID, USER_ID, WORKSPACE_ID, BRANCH_ID, 1, "0.1.0", 7));

        CpApiException error = assertThrows(CpApiException.class, () -> service.continueRun(
                SOURCE_RUN_ID, USER_ID, WORKSPACE_ID, "continuation-key", request));

        assertEquals("CONTINUATION_SOURCE_STALE", error.getCode());
        verify(lineageInvocations, never()).requireContinuationEligible(any(), any());
        verify(runtimeJobGate, never()).requireEligible(any(), any());
        verify(eventPublisher, never()).publishEvent(any(Object.class));
        verify(runs, never()).saveAndFlush(any(ChatRun.class));
    }

    @Test
    void acceptedChildReplayWithSameFreshCheckpointRedispatchesTheSameChild() {
        stubFreshCheckpoint();
        when(lineageInvocations.requireContinuationEligible(SOURCE_RUN_ID, LINEAGE_ID))
                .thenReturn(new LineageInvocationService.ContinuationAdmission(
                        List.of("origin-call-1"), List.of(SOURCE_RUN_ID)));
        ChatRunContinuationRequest request =
                new ChatRunContinuationRequest(ChatRunContinuationRequest.RESUME_PENDING, null);
        String requestHash = ChatRunContinuationHash.calculate(
                new ObjectMapper(), USER_ID, WORKSPACE_ID, SESSION_ID, SOURCE_RUN_ID, request, BRANCH_ID);
        String existingId = UUID.randomUUID().toString();
        ChatRun existing = continuationChild(existingId, requestHash, request.mode(), "accepted");
        when(runs.findByUserIdAndSessionIdAndIdempotencyKey(USER_ID, SESSION_ID, "continuation-key"))
                .thenReturn(Optional.of(existing));

        ChatRunContinuationService.ContinuationResult result = service.continueRun(
                SOURCE_RUN_ID, USER_ID, WORKSPACE_ID, "continuation-key", request);

        assertEquals(existingId, result.runId());
        assertTrue(result.replayed());
        verify(lineageInvocations).requireContinuationEligible(SOURCE_RUN_ID, LINEAGE_ID);
        verify(runtimeJobGate).requireEligible(source, List.of(SOURCE_RUN_ID));
        ArgumentCaptor<ContinuationRunDispatchRequestedEvent> event =
                ArgumentCaptor.forClass(ContinuationRunDispatchRequestedEvent.class);
        verify(eventPublisher).publishEvent(event.capture());
        assertEquals(existingId, event.getValue().continuationRunId());
        assertEquals(List.of("origin-call-1"), event.getValue().completedToolCallIds());
        verify(runs, never()).saveAndFlush(any(ChatRun.class));
    }

    private ChatRun continuationChild(String id, String requestHash, String mode, String status) {
        ChatRun child = new ChatRun(id, SESSION_ID, USER_ID, WORKSPACE_ID,
                "continuation-key", requestHash, "provider", "model", "workspace", status);
        child.setOrigin(ChatRun.ORIGIN_USER_SUBMISSION);
        child.setBranchId(BRANCH_ID);
        child.setContinuationSourceRunId(SOURCE_RUN_ID);
        child.setContinuationLineageId(LINEAGE_ID);
        child.setContinuationThreadId(THREAD_ID);
        child.setContinuationCheckpointId(CHECKPOINT_ID);
        child.setContinuationEventSequence(7L);
        child.setContinuationMode(mode);
        return child;
    }

    /** A missing Session principal is diagnostic only; it does not block HUMAN responder continuation. */
    @Test
    void continuationWithNullSessionPrincipalLogsRunPrincipalStampWithoutFailing() {
        stubNewChildCreation();
        source.setAgentPrincipalId(UUID.randomUUID());
        ListAppender<ILoggingEvent> appender = new ListAppender<>();
        appender.start();
        Logger logger = (Logger) LoggerFactory.getLogger(ChatRunContinuationService.class);
        logger.addAppender(appender);
        try {
            ChatRunContinuationService.ContinuationResult result = service.continueRun(
                    SOURCE_RUN_ID, USER_ID, WORKSPACE_ID, "continuation-key",
                    new ChatRunContinuationRequest(ChatRunContinuationRequest.RESUME_PENDING, null));
            assertNotNull(result.runId(), "log-only: the continuation itself must still succeed");
            assertNull(savedChild().getAgentPrincipalId(), "session NULL must not fall back to the source principal");

            String stamped = appender.list.stream()
                    .map(ILoggingEvent::getFormattedMessage)
                    .filter(message -> message.contains("event=run_principal_stamp"))
                    .findFirst().orElseThrow(() -> new AssertionError(
                            "no run_principal_stamp log: " + appender.list.stream()
                                    .map(ILoggingEvent::getFormattedMessage).toList()));
            assertTrue(stamped.contains("origin=user_submission"), stamped);
            assertTrue(stamped.contains("runId=" + result.runId()), stamped);
            assertTrue(stamped.contains("sessionId=" + SESSION_ID), stamped);
            assertTrue(stamped.contains("sourceRunId=" + SOURCE_RUN_ID), stamped);
        } finally {
            logger.detachAppender(appender);
        }
    }

    @Test
    void humanResponderContinuationUsesSessionPrincipal() {
        stubNewChildCreation();
        UUID sessionPrincipalId = UUID.randomUUID();
        session.setAgentPrincipalId(sessionPrincipalId.toString());
        assertNull(source.getAgentPrincipalId(), "fixture: HUMAN responder source has NULL principal");

        ChatRunContinuationService.ContinuationResult result = service.continueRun(
                SOURCE_RUN_ID, USER_ID, WORKSPACE_ID, "continuation-key",
                new ChatRunContinuationRequest(ChatRunContinuationRequest.RESUME_PENDING, null));

        assertNotNull(result.runId(), "HUMAN responder continuation remains allowed");
        assertEquals(sessionPrincipalId, savedChild().getAgentPrincipalId());
    }

    /** A continuation with a Session principal does not emit the missing-principal diagnostic. */
    @Test
    void aStampedDerivedRunDoesNotLog() {
        stubNewChildCreation();
        source.setAgentPrincipalId(UUID.randomUUID());
        session.setAgentPrincipalId(source.getAgentPrincipalId().toString());
        ListAppender<ILoggingEvent> appender = new ListAppender<>();
        appender.start();
        Logger logger = (Logger) LoggerFactory.getLogger(ChatRunContinuationService.class);
        logger.addAppender(appender);
        try {
            service.continueRun(SOURCE_RUN_ID, USER_ID, WORKSPACE_ID, "continuation-key",
                    new ChatRunContinuationRequest(ChatRunContinuationRequest.RESUME_PENDING, null));
            assertTrue(appender.list.stream().map(ILoggingEvent::getFormattedMessage)
                            .noneMatch(message -> message.contains("event=run_principal_stamp")),
                    "a stamped derived run must not produce the diagnostic");
        } finally {
            logger.detachAppender(appender);
        }
    }

    private void stubNewChildCreation() {
        // PLAN-0645: the former "Session has no in-flight run" read is replaced by the gate's
        // requireSlot (a no-op on the mock), so there is no read-model stub left to set up here.
        stubFreshCheckpoint();
        when(lineageInvocations.requireContinuationEligible(SOURCE_RUN_ID, LINEAGE_ID))
                .thenReturn(new LineageInvocationService.ContinuationAdmission(
                        List.of("origin-call-1"), List.of(SOURCE_RUN_ID)));
        when(runs.saveAndFlush(any(ChatRun.class))).thenAnswer(invocation -> invocation.getArgument(0));
    }

    private void stubFreshCheckpoint() {
        when(checkpoints.findLatestSafeCheckpointForSourceRun(eq(SOURCE_RUN_ID), any()))
                .thenReturn(new AgentGraphCheckpointService.ContinuationCheckpointView(
                        LINEAGE_ID, THREAD_ID, CHECKPOINT_ID, 7,
                        SESSION_ID, USER_ID, WORKSPACE_ID, BRANCH_ID, 1, "0.1.0", 7));
    }

    private ChatRun savedChild() {
        ArgumentCaptor<ChatRun> child = ArgumentCaptor.forClass(ChatRun.class);
        verify(runs).saveAndFlush(child.capture());
        return child.getValue();
    }
}
