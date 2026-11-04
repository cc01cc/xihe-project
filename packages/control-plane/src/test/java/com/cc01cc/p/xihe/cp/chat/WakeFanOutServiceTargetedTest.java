package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.config.ConfigService;
import com.cc01cc.p.xihe.cp.service.WakeDispatchService;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.InOrder;

import java.util.List;
import java.util.Set;
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
 * PLAN-0665 M1 (D1 a'/Q1/Q2): the single TargetedWake entry used by both the one-element and the
 * N-element selection.
 *
 * <p>Pins: (a) dispatch order = selection order, (b) {@code triggerSource="to"} with a NULL
 * {@code parentRunId} (Q2 forbids reusing the delegation chain), (c) returned {@code runIds} are the
 * created runs in that same order (Q1 {@code runId = runIds[0]}), (d) participants already woken by
 * this submission's mention round are not woken twice, (e) one target's failure never aborts the
 * others.</p>
 */
class WakeFanOutServiceTargetedTest {

    private static final UUID SESSION_ID = UUID.randomUUID();
    private static final UUID ROOT_RUN = UUID.randomUUID();
    private static final UUID PLANNER = UUID.randomUUID();
    private static final UUID REVIEWER = UUID.randomUUID();

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
        when(dispatch.fire(eq(participant), eq("to"), anyString(), eq(SESSION_ID), isNull(), anyString()))
                .thenReturn(new WakeDispatchService.WakeFireResult(true, runId, "started"));
    }

    @Test
    void createsRunsInSelectionOrder_andReturnsTheirIds() {
        UUID plannerRun = UUID.randomUUID();
        UUID reviewerRun = UUID.randomUUID();
        dispatched(PLANNER, plannerRun);
        dispatched(REVIEWER, reviewerRun);

        WakeFanOutService.TargetedWake result = fanOut.targetedFanOut(SESSION_ID, "ws-1", "user-1",
                ROOT_RUN.toString(), "请评审", List.of(PLANNER, REVIEWER), Set.of());

        assertThat(result.runIds()).containsExactly(plannerRun, reviewerRun);
        assertThat(result.targets()).isEqualTo(2);
        assertThat(result.skipped()).isZero();
        // triggerSource is "to" and the delegation-chain parent is intentionally NULL (Q2).
        InOrder order = inOrder(dispatch);
        order.verify(dispatch).fire(eq(PLANNER), eq("to"), anyString(), eq(SESSION_ID), isNull(), anyString());
        order.verify(dispatch).fire(eq(REVIEWER), eq("to"), anyString(), eq(SESSION_ID), isNull(), anyString());
        verify(dispatch, never()).fire(eq(PLANNER), eq("mention"), anyString(), any(), any(), any());
    }

    @Test
    void singleTargetGoesThroughTheSameEntry() {
        UUID plannerRun = UUID.randomUUID();
        dispatched(PLANNER, plannerRun);

        WakeFanOutService.TargetedWake result = fanOut.targetedFanOut(SESSION_ID, "ws-1", "user-1",
                ROOT_RUN.toString(), "请评审", List.of(PLANNER), Set.of());

        assertThat(result.runIds()).containsExactly(plannerRun);
        assertThat(result.targets()).isEqualTo(1);
    }

    @Test
    void participantsAlreadyWokenByTheMentionRound_areNotWokenTwice() {
        UUID reviewerRun = UUID.randomUUID();
        dispatched(REVIEWER, reviewerRun);

        WakeFanOutService.TargetedWake result = fanOut.targetedFanOut(SESSION_ID, "ws-1", "user-1",
                ROOT_RUN.toString(), "请评审", List.of(PLANNER, REVIEWER), Set.of(PLANNER));

        assertThat(result.runIds()).containsExactly(reviewerRun);
        assertThat(result.skipped()).isEqualTo(1);
        verify(dispatch, never()).fire(eq(PLANNER), eq("to"), anyString(), any(), any(), any());
    }

    @Test
    void oneTargetsFailureDoesNotAbortTheOthers() {
        UUID reviewerRun = UUID.randomUUID();
        when(dispatch.fire(eq(PLANNER), eq("to"), anyString(), eq(SESSION_ID), isNull(), anyString()))
                .thenThrow(new IllegalStateException("planner exploded"));
        dispatched(REVIEWER, reviewerRun);

        WakeFanOutService.TargetedWake result = fanOut.targetedFanOut(SESSION_ID, "ws-1", "user-1",
                ROOT_RUN.toString(), "请评审", List.of(PLANNER, REVIEWER), Set.of());

        assertThat(result.runIds()).containsExactly(reviewerRun);
        assertThat(result.skipped()).isEqualTo(1);
    }

    @Test
    void nonDispatchedOutcome_countsAsSkippedAndYieldsNoRunId() {
        when(dispatch.fire(eq(PLANNER), eq("to"), anyString(), eq(SESSION_ID), isNull(), anyString()))
                .thenReturn(new WakeDispatchService.WakeFireResult(false, null, "skipped_muted"));

        WakeFanOutService.TargetedWake result = fanOut.targetedFanOut(SESSION_ID, "ws-1", "user-1",
                ROOT_RUN.toString(), "请评审", List.of(PLANNER), Set.of());

        assertThat(result.runIds()).isEmpty();
        assertThat(result.skipped()).isEqualTo(1);
    }

    @Test
    void emptyTargetSet_isANoOp() {
        WakeFanOutService.TargetedWake result = fanOut.targetedFanOut(SESSION_ID, "ws-1", "user-1",
                ROOT_RUN.toString(), "请评审", List.of(), Set.of());

        assertThat(result.runIds()).isEmpty();
        assertThat(result.targets()).isZero();
        verify(dispatch, never()).fire(any(), any(), any(), any(), any(), any());
    }
}
