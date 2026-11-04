package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.config.ConfigService;
import com.cc01cc.p.xihe.cp.context.service.EventStoreService;
import com.cc01cc.p.xihe.cp.repository.SessionParticipantCursorRepository;
import com.cc01cc.p.xihe.cp.service.WakeDispatchService;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.mockito.InOrder;

import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.ArgumentMatchers.isNull;
import static org.mockito.Mockito.inOrder;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.timeout;
import static org.mockito.Mockito.verify;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.Mockito.when;

/**
 * PLAN-0624 M4 (D24-10/15): the serial fan-out — order, @all expansion, terminal-driven
 * continuation and the bounded wait (Q3 超时 failed 续行).
 */
class WakeFanOutServiceTest {

    private static final UUID SESSION_ID = UUID.randomUUID();
    private static final UUID ROOT_RUN = UUID.randomUUID();
    private static final UUID ANN = UUID.randomUUID();
    private static final UUID JOHN = UUID.randomUUID();
    private static final UUID GHOST = UUID.randomUUID();

    private WakeDispatchService dispatch;
    private ConfigService config;
    private WakeFanOutService fanOut;

    private static MentionParser.RosterEntry agent(UUID id, String name) {
        return new MentionParser.RosterEntry(id, "AGENT", name, "MEMBER", "ALWAYS", null);
    }

    @BeforeEach
    void setUp() {
        dispatch = mock(WakeDispatchService.class);
        config = mock(ConfigService.class);
        fanOut = new WakeFanOutService(dispatch, config);
    }

    private List<MentionParser.RosterEntry> roster() {
        return List.of(agent(ANN, "Ann"), agent(JOHN, "John"),
                new MentionParser.RosterEntry(GHOST, "AGENT", "Ghost", "MEMBER", "ALWAYS",
                        Instant.now()));
    }

    @Test
    void mentionsFireInRosterOrderSerially() {
        when(dispatch.fire(eq(ANN), eq("mention"), anyString(), eq(SESSION_ID), isNull(), anyString()))
                .thenReturn(new WakeDispatchService.WakeFireResult(false, null, "skipped_muted"));
        when(dispatch.fire(eq(JOHN), eq("mention"), anyString(), eq(SESSION_ID), isNull(), anyString()))
                .thenReturn(new WakeDispatchService.WakeFireResult(false, null, "skipped_muted"));

        fanOut.fanOut(SESSION_ID, "ws-1", "owner-1", ROOT_RUN.toString(), "@John @Ann 看看", roster());

        InOrder order = inOrder(dispatch);
        order.verify(dispatch, timeout(2000)).fire(eq(JOHN), eq("mention"),
                eq("wake:mention:" + ROOT_RUN), eq(SESSION_ID), isNull(), anyString());
        order.verify(dispatch, timeout(2000)).fire(eq(ANN), eq("mention"),
                eq("wake:mention:" + ROOT_RUN), eq(SESSION_ID), isNull(), anyString());
    }

    @Test
    void allExpandsToEnabledParticipantsOnly() {
        when(dispatch.fire(any(), eq("mention"), anyString(), eq(SESSION_ID), isNull(), anyString()))
                .thenReturn(new WakeDispatchService.WakeFireResult(false, null, "skipped_muted"));

        fanOut.fanOut(SESSION_ID, "ws-1", "owner-1", ROOT_RUN.toString(), "@ALL 大家看", roster());

        verify(dispatch, timeout(2000)).fire(eq(ANN), eq("mention"), anyString(), eq(SESSION_ID), isNull(), anyString());
        verify(dispatch, timeout(2000)).fire(eq(JOHN), eq("mention"), anyString(), eq(SESSION_ID), isNull(), anyString());
        org.mockito.Mockito.verify(dispatch, org.mockito.Mockito.times(2))
                .fire(any(), eq("mention"), anyString(), eq(SESSION_ID), isNull(), anyString());
    }

    @Test
    void recipientsDispatchWithoutWaitingForThePreviousRun() {
        UUID firstRun = UUID.randomUUID();
        when(dispatch.fire(eq(ANN), eq("mention"), anyString(), eq(SESSION_ID), isNull(), anyString()))
                .thenReturn(new WakeDispatchService.WakeFireResult(true, firstRun, "submitted"));
        when(dispatch.fire(eq(JOHN), eq("mention"), anyString(), eq(SESSION_ID), isNull(), anyString()))
                .thenReturn(new WakeDispatchService.WakeFireResult(false, null, "skipped_muted"));

        fanOut.fanOut(SESSION_ID, "ws-1", "owner-1", ROOT_RUN.toString(), "@Ann @John", roster());

        // PLAN-0648 task-34: dispatching never waits for the previous recipient's run — the wait is an
        // observation on its own thread, so both recipients fire even though the first run is slow.
        verify(dispatch, timeout(2000)).fire(eq(ANN), eq("mention"), anyString(), eq(SESSION_ID),
                isNull(), anyString());
        verify(dispatch, timeout(2000)).fire(eq(JOHN), eq("mention"), anyString(), eq(SESSION_ID),
                isNull(), anyString());
    }

    @Test
    void aSlowRunDoesNotDelayTheRoundOrTheNextOne() {
        when(config.resolve(eq("agent-runtime"), eq("wakeDispatchWaitSeconds"), any(), any()))
                .thenReturn("30");
        UUID hangingRun = UUID.randomUUID();
        when(dispatch.fire(eq(ANN), eq("mention"), anyString(), eq(SESSION_ID), isNull(), anyString()))
                .thenReturn(new WakeDispatchService.WakeFireResult(true, hangingRun, "submitted"));
        when(dispatch.fire(eq(JOHN), eq("mention"), anyString(), eq(SESSION_ID), isNull(), anyString()))
                .thenReturn(new WakeDispatchService.WakeFireResult(true, UUID.randomUUID(), "submitted"));

        long startedAt = System.currentTimeMillis();
        fanOut.fanOut(SESSION_ID, "ws-1", "owner-1", ROOT_RUN.toString(), "@Ann @John", roster());
        UUID nextRoot = UUID.randomUUID();
        fanOut.fanOut(SESSION_ID, "ws-1", "owner-1", nextRoot.toString(), "@John next round", roster());

        verify(dispatch, timeout(2000)).fire(eq(JOHN), eq("mention"),
                eq("wake:mention:" + nextRoot), eq(SESSION_ID), isNull(), anyString());
        assertTrue(System.currentTimeMillis() - startedAt < 10_000,
                "neither the round nor the next one may wait on a slow run");
    }

    @Test
    void roundStatsBalanceEnqueuedAgainstStartedDeferredAndDropped() {
        UUID startedRun = UUID.randomUUID();
        when(dispatch.fire(eq(JOHN), eq("mention"), anyString(), eq(SESSION_ID), isNull(), anyString()))
                .thenReturn(new WakeDispatchService.WakeFireResult(true, startedRun, "submitted"));
        when(dispatch.fire(eq(ANN), eq("mention"), anyString(), eq(SESSION_ID), isNull(), anyString()))
                .thenThrow(new IllegalStateException("dispatch exploded"));

        fanOut.fanOut(SESSION_ID, "ws-1", "owner-1", ROOT_RUN.toString(), "@Ann @John look", roster());

        org.awaitility.Awaitility.await().atMost(java.time.Duration.ofSeconds(5))
                .until(() -> fanOut.lastRoundStats() != null);
        WakeFanOutService.WakeRoundStats stats = fanOut.lastRoundStats();
        assertTrue(stats.balanced(), "enqueued == started + deferred + dropped: " + stats);
        assertEquals(2, stats.recipients());
        assertEquals(1, stats.started());
        assertEquals(1, stats.dropped());
        assertEquals(0, stats.deferred());
    }
    // ── PLAN-0648 task-34: every enqueued round must reach a terminal outcome ─────────────

    @Test
    void consecutiveRoundsDrainIndependentlyEvenWhenTheFirstRunNeverFinishes() {
        // Round 1 keeps its awaiter busy for the whole wait window; round 2 must not queue behind it.
        UUID hangingRun = UUID.randomUUID();
        UUID secondRoundRun = UUID.randomUUID();
        when(config.resolve(eq("agent-runtime"), eq("wakeDispatchWaitSeconds"), any(), any()))
                .thenReturn("20");
        when(dispatch.fire(eq(ANN), eq("mention"), anyString(), eq(SESSION_ID), isNull(), anyString()))
                .thenReturn(new WakeDispatchService.WakeFireResult(true, hangingRun, "submitted"));
        when(dispatch.fire(eq(JOHN), eq("mention"), anyString(), eq(SESSION_ID), isNull(), anyString()))
                .thenReturn(new WakeDispatchService.WakeFireResult(true, secondRoundRun, "submitted"));

        long firstEnqueue = System.currentTimeMillis();
        fanOut.fanOut(SESSION_ID, "ws-1", "owner-1", ROOT_RUN.toString(), "@Ann 第一条", roster());
        verify(dispatch, timeout(2000)).fire(eq(ANN), eq("mention"), anyString(), eq(SESSION_ID),
                isNull(), anyString());

        UUID secondRootRun = UUID.randomUUID();
        fanOut.fanOut(SESSION_ID, "ws-1", "owner-1", secondRootRun.toString(), "@John 第二条", roster());

        // The proof of no head-of-line blocking: round 2 fires while round 1 is still awaiting.
        verify(dispatch, timeout(2000)).fire(eq(JOHN), eq("mention"),
                eq("wake:mention:" + secondRootRun), eq(SESSION_ID), isNull(), anyString());
        long elapsedMs = System.currentTimeMillis() - firstEnqueue;
        assertTrue(elapsedMs < 15_000,
                "round 2 must not wait for round 1's wait window (elapsed=" + elapsedMs + "ms)");
        // Round 1's observation is still outstanding on the observer thread; round 2 already ran.
        org.awaitility.Awaitility.await().atMost(java.time.Duration.ofSeconds(5))
                .until(() -> fanOut.isAwaiting(hangingRun.toString()));
    }

    @Test
    void aRunThatIsAlreadyTerminalDoesNotBurnTheWaitWindow() {
        UUID quickRun = UUID.randomUUID();
        when(config.resolve(eq("agent-runtime"), eq("wakeDispatchWaitSeconds"), any(), any()))
                .thenReturn("30");
        when(dispatch.fire(eq(ANN), eq("mention"), anyString(), eq(SESSION_ID), isNull(), anyString()))
                .thenReturn(new WakeDispatchService.WakeFireResult(true, quickRun, "submitted"));
        WakeFanOutService spyFanOut = org.mockito.Mockito.spy(fanOut);
        ChatRunStatusReadService status = mock(ChatRunStatusReadService.class);
        when(status.findById(quickRun)).thenReturn(java.util.Optional.of(
                new ChatRunStatusReadService.ChatRunStatusView(quickRun, "succeeded",
                        SESSION_ID.toString(), "owner-1", "ws-1", null, null)));
        org.springframework.test.util.ReflectionTestUtils.setField(spyFanOut, "chatRunStatus", status);

        long startedAt = System.currentTimeMillis();
        spyFanOut.fanOut(SESSION_ID, "ws-1", "owner-1", ROOT_RUN.toString(), "@Ann 秒回", roster());

        verify(dispatch, timeout(2000)).fire(eq(ANN), eq("mention"), anyString(), eq(SESSION_ID),
                isNull(), anyString());
        org.awaitility.Awaitility.await().atMost(java.time.Duration.ofSeconds(5))
                .until(() -> !spyFanOut.isAwaiting(quickRun.toString()));
        long elapsedMs = System.currentTimeMillis() - startedAt;
        assertTrue(elapsedMs < 5_000,
                "an already-terminal run must not occupy the 30s wait (elapsed=" + elapsedMs + "ms)");
    }

    @Test
    void aFailingRecipientStillKeepsEveryOtherRecipientAndTheCcObserversDelivered() {
        // PLAN-0660 T2.3 (I3): one recipient blowing up must not end the round, and the cc observers
        // must still be notified. Assertions: later recipients still fire, the observer's durable
        // notify row is written exactly once per observer (notifyObserver is private — the append is
        // its first observable effect), and the round counters stay balanced.
        UUID ccObserver = UUID.randomUUID();
        EventStoreService eventStore = mock(EventStoreService.class);
        SessionParticipantCursorRepository cursors = mock(SessionParticipantCursorRepository.class);
        WakeFanOutService fanOutWithStore = new WakeFanOutService(dispatch, config, eventStore, cursors);
        when(dispatch.fire(eq(ANN), eq("mention"), anyString(), eq(SESSION_ID), isNull(), anyString()))
                .thenThrow(new IllegalStateException("first recipient exploded"));
        when(dispatch.fire(eq(JOHN), eq("mention"), anyString(), eq(SESSION_ID), isNull(), anyString()))
                .thenReturn(new WakeDispatchService.WakeFireResult(false, null, "skipped_muted"));
        List<MentionParser.RosterEntry> roundRoster = List.of(agent(ANN, "Ann"), agent(JOHN, "John"),
                agent(ccObserver, "Observer"));

        WakeFanOutService.WakeHandoff handoff = fanOutWithStore.fanOut(SESSION_ID, "ws-1", "owner-1",
                ROOT_RUN.toString(), "@Ann @John 都别停", roundRoster, List.of(ccObserver));

        assertTrue(handoff.enqueued(), "the round is still handed off");
        InOrder order = inOrder(dispatch);
        order.verify(dispatch, timeout(2000)).fire(eq(ANN), eq("mention"), anyString(),
                eq(SESSION_ID), isNull(), anyString());
        order.verify(dispatch, timeout(2000)).fire(eq(JOHN), eq("mention"), anyString(),
                eq(SESSION_ID), isNull(), anyString());

        @SuppressWarnings("unchecked")
        ArgumentCaptor<Map<String, Object>> payload = ArgumentCaptor.forClass(Map.class);
        verify(eventStore, timeout(2000)).append(eq(SESSION_ID.toString()), eq("ws-1"), eq("owner-1"),
                eq(WakeFanOutService.EVENT_WAKE_DISPATCH), payload.capture());
        assertEquals("cc", payload.getValue().get("triggerSource"));
        assertEquals(ccObserver.toString(), payload.getValue().get("participantId"));
        assertEquals("notify", payload.getValue().get("outcome"));

        WakeFanOutService.WakeRoundStats stats = fanOutWithStore.lastRoundStats();
        assertEquals(1, stats.dropped(), "the failed recipient is counted, never silent");
        assertEquals(1, stats.deferred(), "the surviving recipient still ran");
        assertEquals(1, stats.ccObservers(), "cc must match the delivered observer count");
        assertTrue(stats.balanced(), "enqueued == started + deferred + dropped");
    }

    @Test
    void aFailingRecipientStillLetsTheRoundFinishAndTheNextRoundDrain() {
        UUID secondRun = UUID.randomUUID();
        when(dispatch.fire(eq(ANN), eq("mention"), anyString(), eq(SESSION_ID), isNull(), anyString()))
                .thenThrow(new IllegalStateException("dispatch exploded"));
        when(dispatch.fire(eq(JOHN), eq("mention"), anyString(), eq(SESSION_ID), isNull(), anyString()))
                .thenReturn(new WakeDispatchService.WakeFireResult(true, secondRun, "submitted"));

        fanOut.fanOut(SESSION_ID, "ws-1", "owner-1", ROOT_RUN.toString(), "@Ann 炸了", roster());

        // The drop is recorded (wake_handoff_dropped) and the round still ends, so later rounds run.
        UUID nextRoot = UUID.randomUUID();
        fanOut.fanOut(SESSION_ID, "ws-1", "owner-1", nextRoot.toString(), "@John 后一轮", roster());
        verify(dispatch, timeout(2000)).fire(eq(JOHN), eq("mention"),
                eq("wake:mention:" + nextRoot), eq(SESSION_ID), isNull(), anyString());
    }
}
