package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.entity.ChatRun;
import com.cc01cc.p.xihe.cp.entity.SessionParticipant;
import com.cc01cc.p.xihe.cp.repository.ChatRunRepository;
import com.cc01cc.p.xihe.cp.repository.SessionParticipantRepository;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.http.HttpStatus;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * task-40 S3 (D-1884 / D-1885): the agent-initiated TO face. Unit-level here, because the two
 * questions this class answers are about the ORDER and the ACCOUNTING of one call, and both are
 * already covered end to end where they belong to the database (ChatSubmissionServiceIntegrationTest
 * proves the write-kind side; WakeFanOutServiceTest proves the dispatch coordinates).
 *
 * <p>The cases named "no announcement" are the 失败不静默 half of the card: a sentence claiming a
 * hand-off must never be the only trace of a round that woke nobody.</p>
 */
class AgentHandoffServiceTest {

    private static final UUID CALLER_RUN = UUID.randomUUID();
    private static final UUID SESSION_ID = UUID.randomUUID();
    private static final UUID RESPONDER_PRINCIPAL = UUID.randomUUID();
    private static final UUID CALLER_PARTICIPANT = UUID.randomUUID();
    private static final UUID TARGET = UUID.randomUUID();
    private static final UUID OBSERVER = UUID.randomUUID();
    private static final String KEY = "handoff-key-1";

    private ChatRunRepository chatRunRepository;
    private SessionParticipantRepository participantRepository;
    private ChatSubmissionService submissionService;
    private WakeFanOutService wakeFanOutService;
    private AgentHandoffService service;
    private ChatRun run;

    @BeforeEach
    void setUp() {
        chatRunRepository = mock(ChatRunRepository.class);
        participantRepository = mock(SessionParticipantRepository.class);
        submissionService = mock(ChatSubmissionService.class);
        wakeFanOutService = mock(WakeFanOutService.class);
        service = new AgentHandoffService(chatRunRepository, participantRepository, submissionService,
                wakeFanOutService);
        run = mock(ChatRun.class);
        when(run.getSessionId()).thenReturn(SESSION_ID.toString());
        when(run.getWorkspaceId()).thenReturn("ws-1");
        when(run.getUserId()).thenReturn("owner-1");
        when(run.getAgentPrincipalId()).thenReturn(RESPONDER_PRINCIPAL);
        when(run.getStatus()).thenReturn("running");
        when(chatRunRepository.findById(CALLER_RUN)).thenReturn(Optional.of(run));
        SessionParticipant caller = mock(SessionParticipant.class);
        when(caller.getId()).thenReturn(CALLER_PARTICIPANT);
        when(participantRepository.findFirstBySessionIdAndPrincipalId(SESSION_ID, RESPONDER_PRINCIPAL))
                .thenReturn(Optional.of(caller));
    }

    private static WakeFanOutService.TargetedWake dispatched(UUID runId, int targets) {
        return new WakeFanOutService.TargetedWake(List.of(runId), List.of(), List.of(), List.of(),
                List.of(), targets);
    }

    private static WakeFanOutService.TargetedWake nothingHappened(int targets, String reason) {
        return new WakeFanOutService.TargetedWake(List.of(),
                List.of(new WakeFanOutService.TargetedFailure(UUID.randomUUID().toString(), reason,
                        "cross_session")),
                List.of(), List.of(), List.of(), targets);
    }

    @Test
    void happyPathAnnouncesOnceUnderTheCallingRunAndHandsOffThroughTheAgentRound() {
        UUID childRun = UUID.randomUUID();
        when(wakeFanOutService.agentHandoffFanOut(eq(SESSION_ID), eq("ws-1"), eq("owner-1"),
                eq(CALLER_RUN.toString()), anyString(), eq(List.of(TARGET))))
                .thenReturn(dispatched(childRun, 1));
        when(wakeFanOutService.notifyExplicitObservers(eq(SESSION_ID), eq("ws-1"), eq("owner-1"),
                eq("wake:to:agent:" + CALLER_RUN), eq(List.of(OBSERVER))))
                .thenReturn(List.of(OBSERVER));
        when(submissionService.persistAssistantResponse(eq(SESSION_ID.toString()),
                eq(CALLER_RUN.toString()), eq("交接给你，请接手 T-标记"), any(),
                eq(ChatSubmissionService.AssistantWriteKind.AGENT_HANDOFF)))
                .thenReturn("message-1");

        AgentHandoffService.HandoffOutcome outcome = service.handoff(CALLER_RUN.toString(),
                "交接给你，请接手 T-标记", List.of(TARGET), List.of(OBSERVER), KEY);

        assertEquals("message-1", outcome.messageId());
        assertEquals("wake:to:agent:" + CALLER_RUN, outcome.roundId());
        assertEquals(List.of(OBSERVER), outcome.ccNotified());
        assertEquals(1, outcome.to().runIds().size());
        verify(submissionService).persistAssistantResponse(eq(SESSION_ID.toString()),
                eq(CALLER_RUN.toString()), eq("交接给你，请接手 T-标记"), any(),
                eq(ChatSubmissionService.AssistantWriteKind.AGENT_HANDOFF));
    }

    /**
     * N3: the fan-out must be entered with the CALLING run as parent, never NULL — that coordinate is
     * what makes the durable wake edge real and what makes the duplicate-hop gate exist at all.
     */
    @Test
    void handoffCarriesTheCallingRunAsTheWakeEdgeParent() {
        when(wakeFanOutService.agentHandoffFanOut(any(), anyString(), anyString(), anyString(),
                anyString(), any())).thenReturn(dispatched(UUID.randomUUID(), 1));
        service.handoff(CALLER_RUN.toString(), "接手吧", List.of(TARGET), List.of(), KEY);
        ArgumentCaptor<String> parent = ArgumentCaptor.forClass(String.class);
        verify(wakeFanOutService).agentHandoffFanOut(eq(SESSION_ID), eq("ws-1"), eq("owner-1"),
                parent.capture(), eq("接手吧"), eq(List.of(TARGET)));
        assertEquals(CALLER_RUN.toString(), parent.getValue(),
                "the agent round is a delegation edge, not a sibling of a user submission");
    }

    /** 失败不静默: every target failed ⇒ the session gets no sentence claiming a hand-off. */
    @Test
    void nothingActedOnAnnouncesNothing() {
        when(wakeFanOutService.agentHandoffFanOut(any(), anyString(), anyString(), anyString(),
                anyString(), any())).thenReturn(nothingHappened(1, "refused"));
        when(wakeFanOutService.notifyExplicitObservers(any(), anyString(), anyString(), anyString(),
                any())).thenReturn(List.of());

        AgentHandoffService.HandoffOutcome outcome = service.handoff(CALLER_RUN.toString(),
                "交接给外人", List.of(TARGET), List.of(OBSERVER), KEY);

        assertNull(outcome.messageId(), "no run, no queue, no notify, no suppression ⇒ no announcement");
        assertEquals(List.of(OBSERVER), outcome.ccIgnored());
        verify(submissionService, never()).persistAssistantResponse(anyString(), anyString(), anyString(),
                any(), any());
    }

    /** A suppressed target still counts as acted on: "I do not answer" must not mean nobody answers. */
    @Test
    void suppressedTargetStillAnnounces() {
        when(wakeFanOutService.agentHandoffFanOut(any(), anyString(), anyString(), anyString(),
                anyString(), any())).thenReturn(new WakeFanOutService.TargetedWake(List.of(), List.of(),
                List.of(), List.of(), List.of(new WakeFanOutService.TargetedFailure(
                TARGET.toString(), "skipped_muted", "respond_policy_muted")), 1));
        when(submissionService.persistAssistantResponse(anyString(), anyString(), anyString(), any(),
                any())).thenReturn("message-2");
        assertEquals("message-2", service.handoff(CALLER_RUN.toString(), "交接", List.of(TARGET),
                List.of(), KEY).messageId());
    }

    /** TO owns the target: the same id in CC must not be notified twice (human-face rule reused). */
    @Test
    void duplicateObserverOfAToTargetIsNotNotifiedTwice() {
        when(wakeFanOutService.agentHandoffFanOut(any(), anyString(), anyString(), anyString(),
                anyString(), any())).thenReturn(dispatched(UUID.randomUUID(), 1));
        when(wakeFanOutService.notifyExplicitObservers(any(), anyString(), anyString(), anyString(),
                eq(List.of()))).thenReturn(List.of());
        service.handoff(CALLER_RUN.toString(), "交接", List.of(TARGET), List.of(TARGET), KEY);
        verify(wakeFanOutService).notifyExplicitObservers(eq(SESSION_ID), eq("ws-1"), eq("owner-1"),
                eq("wake:to:agent:" + CALLER_RUN), eq(List.of()));
    }

    @Test
    void repeatedTargetsAreCollapsedBeforeDispatch() {
        when(wakeFanOutService.agentHandoffFanOut(any(), anyString(), anyString(), anyString(),
                anyString(), any())).thenReturn(dispatched(UUID.randomUUID(), 1));
        service.handoff(CALLER_RUN.toString(), "交接", List.of(TARGET, TARGET), List.of(), KEY);
        verify(wakeFanOutService).agentHandoffFanOut(eq(SESSION_ID), eq("ws-1"), eq("owner-1"),
                eq(CALLER_RUN.toString()), eq("交接"), eq(List.of(TARGET)));
    }

    @Test
    void missingIdempotencyKeyIsRejectedBeforeAnythingIsRead() {
        CpApiException failure = assertThrows(CpApiException.class,
                () -> service.handoff(CALLER_RUN.toString(), "交接", List.of(TARGET), List.of(), null));
        assertEquals(HttpStatus.BAD_REQUEST, failure.getStatus());
        assertEquals("HANDOFF_IDEMPOTENCY_KEY_REQUIRED", failure.getCode());
        verify(chatRunRepository, never()).findById(any());
    }

    @Test
    void blankContentIsRejected() {
        CpApiException failure = assertThrows(CpApiException.class,
                () -> service.handoff(CALLER_RUN.toString(), "   ", List.of(TARGET), List.of(), KEY));
        assertEquals(HttpStatus.UNPROCESSABLE_ENTITY, failure.getStatus());
        assertEquals("HANDOFF_CONTENT_REQUIRED", failure.getCode());
    }

    @Test
    void emptyAudienceIsRejected() {
        CpApiException failure = assertThrows(CpApiException.class,
                () -> service.handoff(CALLER_RUN.toString(), "交接", List.of(), List.of(), KEY));
        assertEquals(HttpStatus.UNPROCESSABLE_ENTITY, failure.getStatus());
        assertEquals("HANDOFF_TARGETS_REQUIRED", failure.getCode());
    }

    @Test
    void unknownRunIsFourOhFour() {
        when(chatRunRepository.findById(any())).thenReturn(Optional.empty());
        CpApiException failure = assertThrows(CpApiException.class,
                () -> service.handoff(CALLER_RUN.toString(), "交接", List.of(TARGET), List.of(), KEY));
        assertEquals(HttpStatus.NOT_FOUND, failure.getStatus());
        assertEquals("HANDOFF_RUN_NOT_FOUND", failure.getCode());
    }

    @Test
    void terminalRunCannotHandOff() {
        when(run.getStatus()).thenReturn("succeeded");
        CpApiException failure = assertThrows(CpApiException.class,
                () -> service.handoff(CALLER_RUN.toString(), "交接", List.of(TARGET), List.of(), KEY));
        assertEquals(HttpStatus.CONFLICT, failure.getStatus());
        assertEquals("HANDOFF_RUN_NOT_ACTIVE", failure.getCode());
        verify(wakeFanOutService, never()).agentHandoffFanOut(any(), anyString(), anyString(),
                anyString(), anyString(), any());
    }

    @Test
    void unattributedRunCannotHandOff() {
        when(run.getAgentPrincipalId()).thenReturn(null);
        CpApiException failure = assertThrows(CpApiException.class,
                () -> service.handoff(CALLER_RUN.toString(), "交接", List.of(TARGET), List.of(), KEY));
        assertEquals(HttpStatus.CONFLICT, failure.getStatus());
        assertEquals("HANDOFF_RUN_HAS_NO_RESPONDER", failure.getCode());
    }

    /** Naming yourself is the same mistake the composer already refuses with this token. */
    @Test
    void selfTargetIsRejected() {
        CpApiException failure = assertThrows(CpApiException.class,
                () -> service.handoff(CALLER_RUN.toString(), "交接给自己", List.of(CALLER_PARTICIPANT),
                        List.of(), KEY));
        assertEquals(HttpStatus.BAD_REQUEST, failure.getStatus());
        assertEquals("PARTICIPANT_SELF_TARGET", failure.getCode());
    }

    @Test
    void selfTargetViaCcIsRejectedToo() {
        CpApiException failure = assertThrows(CpApiException.class,
                () -> service.handoff(CALLER_RUN.toString(), "旁听我自己", List.of(TARGET),
                        List.of(CALLER_PARTICIPANT), KEY));
        assertEquals("PARTICIPANT_SELF_TARGET", failure.getCode());
    }

    /**
     * The body carries no actor field anywhere on this face, so a hand-off can only ever be attributed
     * to the run that asks: the responder principal is READ from the run row (Q2 — no new atom).
     */
    @Test
    void provenanceComesFromTheRunRowOnly() {
        when(wakeFanOutService.agentHandoffFanOut(any(), anyString(), anyString(), anyString(),
                anyString(), any())).thenReturn(dispatched(UUID.randomUUID(), 1));
        service.handoff(CALLER_RUN.toString(), "交接", List.of(TARGET), List.of(), KEY);
        verify(run).getAgentPrincipalId();
        // One read per provenance field: the row is the only actor source on this face.
        verify(run).getSessionId();
        verify(run).getWorkspaceId();
        verify(run).getUserId();
        verify(submissionService).persistAssistantResponse(eq(SESSION_ID.toString()),
                eq(CALLER_RUN.toString()), anyString(), any(),
                eq(ChatSubmissionService.AssistantWriteKind.AGENT_HANDOFF));
        verify(wakeFanOutService, never()).targetedFanOut(any(), anyString(), anyString(), anyString(),
                anyString(), any());
    }
}
