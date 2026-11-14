package com.cc01cc.p.xihe.cp.chat;

import ch.qos.logback.classic.Level;
import ch.qos.logback.classic.Logger;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.core.read.ListAppender;
import com.cc01cc.p.xihe.cp.config.ConfigService;
import com.cc01cc.p.xihe.cp.service.WakeDispatchService;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.InOrder;
import org.slf4j.LoggerFactory;

import java.util.List;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.ArgumentMatchers.isNull;
import static org.mockito.Mockito.inOrder;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * PLAN-0665 M1 (D1 a'/Q1/Q2) + the 2026-11-05 real-stack finding.
 *
 * <p>Pins: (a) dispatch order = selection order, (b) the run column gets {@code "user"} while the
 * audit label stays {@code "to"} (writing {@code "to"} into {@code chat_runs.trigger_source} violates
 * its CHECK — the real-stack defect this class now guards), (c) {@code parentRunId} stays NULL
 * (Q2), (d) one target's failure never aborts the others AND is reported in {@code failedTargets[]},
 * (e) {@code runIds + failedTargets + deferredTargets + notifiedTargets == targets} always.</p>
 *
 * <p>task-53 (D-1438 precondition): a HUMAN target's outcome is {@code notify} — a delivered
 * notification IS the delivery, not a failure. It gets its own bucket, an INFO line and no ERROR
 * log. The guard that still refuses human TO lives in
 * {@code SessionParticipantService#authorizeToTargets} and opens with task-48.</p>
 */
class WakeFanOutServiceTargetedTest {

    private static final UUID SESSION_ID = UUID.randomUUID();
    private static final UUID ROOT_RUN = UUID.randomUUID();
    private static final UUID PLANNER = UUID.randomUUID();
    private static final UUID REVIEWER = UUID.randomUUID();
    private static final UUID CONSULTANT = UUID.randomUUID();

    private WakeDispatchService dispatch;
    private WakeFanOutService fanOut;

    @BeforeEach
    void setUp() {
        dispatch = mock(WakeDispatchService.class);
        ConfigService config = mock(ConfigService.class);
        when(config.resolve(eq("agent-runtime"), eq("wakeDispatchWaitSeconds"), any(), any()))
                .thenReturn("1");
        fanOut = new WakeFanOutService(dispatch, config);
    }

    private void dispatched(UUID participant, UUID runId) {
        when(dispatch.fire(eq(participant), eq("user"), eq("to"), anyString(), eq(SESSION_ID), isNull(),
                anyString()))
                .thenReturn(new WakeDispatchService.WakeFireResult(true, runId, "submitted"));
    }

    @Test
    void createsRunsInSelectionOrder_andReturnsTheirIds() {
        UUID plannerRun = UUID.randomUUID();
        UUID reviewerRun = UUID.randomUUID();
        dispatched(PLANNER, plannerRun);
        dispatched(REVIEWER, reviewerRun);

        WakeFanOutService.TargetedWake result = fanOut.targetedFanOut(SESSION_ID, "ws-1", "user-1",
                ROOT_RUN.toString(), "请评审", List.of(PLANNER, REVIEWER));

        assertThat(result.runIds()).containsExactly(plannerRun, reviewerRun);
        assertThat(result.failedTargets()).isEmpty();
        assertThat(result.targets()).isEqualTo(2);
        assertThat(result.accounted()).isEqualTo(2);
        // Run column = "user" (CHECK-safe), audit label = "to", delegation parent = NULL (Q2).
        InOrder order = inOrder(dispatch);
        order.verify(dispatch).fire(eq(PLANNER), eq("user"), eq("to"), anyString(), eq(SESSION_ID),
                isNull(), anyString());
        order.verify(dispatch).fire(eq(REVIEWER), eq("user"), eq("to"), anyString(), eq(SESSION_ID),
                isNull(), anyString());
        verify(dispatch, never()).fire(eq(PLANNER), eq("to"), eq("to"), any(), any(), any(), any());
    }

    @Test
    void singleTargetGoesThroughTheSameEntry() {
        UUID plannerRun = UUID.randomUUID();
        dispatched(PLANNER, plannerRun);

        WakeFanOutService.TargetedWake result = fanOut.targetedFanOut(SESSION_ID, "ws-1", "user-1",
                ROOT_RUN.toString(), "请评审", List.of(PLANNER));

        assertThat(result.runIds()).containsExactly(plannerRun);
        assertThat(result.targets()).isEqualTo(1);
    }

    @Test
    void oneTargetsFailureIsReported_andDoesNotAbortTheOthers() {
        UUID reviewerRun = UUID.randomUUID();
        when(dispatch.fire(eq(PLANNER), eq("user"), eq("to"), anyString(), eq(SESSION_ID), isNull(),
                anyString()))
                .thenThrow(new IllegalStateException("planner exploded"));
        dispatched(REVIEWER, reviewerRun);

        WakeFanOutService.TargetedWake result = fanOut.targetedFanOut(SESSION_ID, "ws-1", "user-1",
                ROOT_RUN.toString(), "请评审", List.of(PLANNER, REVIEWER));

        assertThat(result.runIds()).containsExactly(reviewerRun);
        assertThat(result.failedTargets()).hasSize(1);
        assertThat(result.failedTargets().get(0).participantId()).isEqualTo(PLANNER.toString());
        assertThat(result.failedTargets().get(0).reason()).isEqualTo("IllegalStateException");
        assertThat(result.accounted()).isEqualTo(2);
    }

    @Test
    void dbConstraintViolation_isReportedNotSwallowed() {
        UUID reviewerRun = UUID.randomUUID();
        when(dispatch.fire(eq(PLANNER), eq("user"), eq("to"), anyString(), eq(SESSION_ID), isNull(),
                anyString()))
                .thenThrow(new IllegalStateException("ck_chat_runs_trigger_source violated"));
        dispatched(REVIEWER, reviewerRun);

        WakeFanOutService.TargetedWake result = fanOut.targetedFanOut(SESSION_ID, "ws-1", "user-1",
                ROOT_RUN.toString(), "请评审", List.of(PLANNER, REVIEWER));

        assertThat(result.failedTargets()).hasSize(1);
        assertThat(result.failedTargets().get(0).reason()).isEqualTo("IllegalStateException");
        assertThat(result.runIds()).containsExactly(reviewerRun);
    }

    /**
     * task-53 deliberately leaves {@code skipped_muted} in {@code failedTargets[]}: a muted
     * participant is neither a delivered notice (filing it under notified would claim the user was
     * told) nor a queued target (nothing waits for a slot) — so this is the only bucket that does
     * not lie. What is wrong is the <b>level</b> (ERROR), not the bucket; the suppressed bucket and
     * the level downgrade for {@code refused}/{@code skipped_muted}/{@code judged_no} are task-60,
     * blocked on task-53. Assertions here are unchanged on purpose.
     */
    @Test
    void unclassifiedNonDispatchedOutcome_staysInFailedTargets() {
        when(dispatch.fire(eq(PLANNER), eq("user"), eq("to"), anyString(), eq(SESSION_ID), isNull(),
                anyString()))
                .thenReturn(new WakeDispatchService.WakeFireResult(false, null, "skipped_muted"));

        WakeFanOutService.TargetedWake result = fanOut.targetedFanOut(SESSION_ID, "ws-1", "user-1",
                ROOT_RUN.toString(), "请评审", List.of(PLANNER));

        assertThat(result.runIds()).isEmpty();
        assertThat(result.failedTargets()).hasSize(1);
        assertThat(result.failedTargets().get(0).reason()).isEqualTo("skipped_muted");
        assertThat(result.deferredTargets()).isEmpty();
        assertThat(result.accounted()).isEqualTo(1);
    }

    /**
     * task-53 judgement 2/3: a HUMAN target returns {@code outcome=notify} — the durable
     * {@code wake_dispatch} row and the actual delivery are WakeDispatchService's job and are already
     * done by the time this returns. The target must land in {@code notifiedTargets[]}, never in
     * {@code failedTargets[]}, and must not log {@code to_target_dispatch_failed} at ERROR: that
     * ERROR was the projection bug this card removes. Both halves are asserted — the bucket AND the
     * absence of any WARN/ERROR event — because a fix that only moved the bucket would still be
     * lying in the logs.
     */
    @Test
    void notifyOutcome_landsInNotifiedTargets_withNoErrorLog() {
        when(dispatch.fire(eq(PLANNER), eq("user"), eq("to"), anyString(), eq(SESSION_ID), isNull(),
                anyString()))
                .thenReturn(new WakeDispatchService.WakeFireResult(false, null, "notify"));

        Logger serviceLogger = (Logger) LoggerFactory.getLogger(WakeFanOutService.class);
        ListAppender<ILoggingEvent> appender = new ListAppender<>();
        appender.start();
        serviceLogger.addAppender(appender);
        WakeFanOutService.TargetedWake result;
        try {
            result = fanOut.targetedFanOut(SESSION_ID, "ws-1", "user-1", ROOT_RUN.toString(),
                    "请评审", List.of(PLANNER));
        } finally {
            serviceLogger.detachAppender(appender);
        }

        assertThat(result.notifiedTargets()).hasSize(1);
        assertThat(result.notifiedTargets().get(0).participantId()).isEqualTo(PLANNER.toString());
        assertThat(result.notifiedTargets().get(0).reason()).isEqualTo("notify");
        assertThat(result.failedTargets()).as("a delivered notice is not a failure").isEmpty();
        assertThat(result.deferredTargets()).isEmpty();
        assertThat(result.accounted()).isEqualTo(1);

        assertThat(appender.list).anySatisfy(event -> {
            assertThat(event.getLevel()).isEqualTo(Level.INFO);
            assertThat(event.getFormattedMessage()).contains("event=to_target_notified");
        });
        assertThat(appender.list.stream()
                .filter(event -> event.getLevel().isGreaterOrEqual(Level.WARN))
                .map(ILoggingEvent::getFormattedMessage)
                .toList())
                .as("task-53: the notify path must not log to_target_dispatch_failed at ERROR")
                .isEmpty();
    }

    /** BL-283: a target deferred by the run cap is QUEUED, not failed (Lead ruling 2026-11-05). */
    @Test
    void deferredOutcome_landsInDeferredTargets_notInFailedTargets() {
        when(dispatch.fire(eq(PLANNER), eq("user"), eq("to"), anyString(), eq(SESSION_ID), isNull(),
                anyString()))
                .thenReturn(new WakeDispatchService.WakeFireResult(false, null, "deferred"));

        WakeFanOutService.TargetedWake result = fanOut.targetedFanOut(SESSION_ID, "ws-1", "user-1",
                ROOT_RUN.toString(), "请评审", List.of(PLANNER));

        assertThat(result.runIds()).isEmpty();
        assertThat(result.failedTargets()).as("deferred is not a failure").isEmpty();
        assertThat(result.deferredTargets()).hasSize(1);
        assertThat(result.deferredTargets().get(0).participantId()).isEqualTo(PLANNER.toString());
        assertThat(result.deferredTargets().get(0).reason()).isEqualTo("deferred");
        assertThat(result.accounted()).isEqualTo(1);
    }

    /** BL-283 conservation: every requested target is exactly one of dispatched / deferred / failed. */
    @Test
    void everyTargetIsAccountedFor_acrossTheThreeBuckets() {
        UUID reviewerRun = UUID.randomUUID();
        dispatched(REVIEWER, reviewerRun);
        when(dispatch.fire(eq(PLANNER), eq("user"), eq("to"), anyString(), eq(SESSION_ID), isNull(),
                anyString()))
                .thenReturn(new WakeDispatchService.WakeFireResult(false, null, "deferred"));
        when(dispatch.fire(eq(CONSULTANT), eq("user"), eq("to"), anyString(), eq(SESSION_ID), isNull(),
                anyString()))
                .thenThrow(new IllegalStateException("boom"));

        WakeFanOutService.TargetedWake result = fanOut.targetedFanOut(SESSION_ID, "ws-1", "user-1",
                ROOT_RUN.toString(), "请评审", List.of(PLANNER, REVIEWER, CONSULTANT));

        assertThat(result.runIds()).containsExactly(reviewerRun);
        assertThat(result.deferredTargets()).hasSize(1);
        assertThat(result.failedTargets()).hasSize(1);
        assertThat(result.accounted())
                .as("runIds + failedTargets + deferredTargets == targets")
                .isEqualTo(result.targets())
                .isEqualTo(3);
    }

    @Test
    void emptyTargetSet_isANoOp() {
        WakeFanOutService.TargetedWake result = fanOut.targetedFanOut(SESSION_ID, "ws-1", "user-1",
                ROOT_RUN.toString(), "请评审", List.of());

        assertThat(result.runIds()).isEmpty();
        assertThat(result.failedTargets()).isEmpty();
        assertThat(result.targets()).isZero();
        verify(dispatch, never()).fire(any(), any(), any(), any(), any(), any(), any());
    }
}
