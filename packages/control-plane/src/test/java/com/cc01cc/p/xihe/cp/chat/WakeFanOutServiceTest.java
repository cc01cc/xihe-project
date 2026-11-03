package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.config.ConfigService;
import com.cc01cc.p.xihe.cp.service.WakeDispatchService;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.InOrder;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.ArgumentMatchers.isNull;
import static org.mockito.Mockito.inOrder;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.timeout;
import static org.mockito.Mockito.verify;
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
        when(dispatch.fire(eq(ANN), eq("mention"), anyString(), eq(SESSION_ID), isNull()))
                .thenReturn(new WakeDispatchService.WakeFireResult(false, null, "skipped_muted"));
        when(dispatch.fire(eq(JOHN), eq("mention"), anyString(), eq(SESSION_ID), isNull()))
                .thenReturn(new WakeDispatchService.WakeFireResult(false, null, "skipped_muted"));

        fanOut.fanOut(SESSION_ID, "ws-1", "owner-1", ROOT_RUN.toString(), "@John @Ann 看看", roster());

        InOrder order = inOrder(dispatch);
        order.verify(dispatch, timeout(2000)).fire(eq(JOHN), eq("mention"),
                eq("wake:mention:" + ROOT_RUN), eq(SESSION_ID), isNull());
        order.verify(dispatch, timeout(2000)).fire(eq(ANN), eq("mention"),
                eq("wake:mention:" + ROOT_RUN), eq(SESSION_ID), isNull());
    }

    @Test
    void allExpandsToEnabledParticipantsOnly() {
        when(dispatch.fire(any(), eq("mention"), anyString(), eq(SESSION_ID), isNull()))
                .thenReturn(new WakeDispatchService.WakeFireResult(false, null, "skipped_muted"));

        fanOut.fanOut(SESSION_ID, "ws-1", "owner-1", ROOT_RUN.toString(), "@ALL 大家看", roster());

        verify(dispatch, timeout(2000)).fire(eq(ANN), eq("mention"), anyString(), eq(SESSION_ID), isNull());
        verify(dispatch, timeout(2000)).fire(eq(JOHN), eq("mention"), anyString(), eq(SESSION_ID), isNull());
        org.mockito.Mockito.verify(dispatch, org.mockito.Mockito.times(2))
                .fire(any(), eq("mention"), anyString(), eq(SESSION_ID), isNull());
    }

    @Test
    void terminalEventUnblocksTheSerialLoop() {
        UUID firstRun = UUID.randomUUID();
        when(dispatch.fire(eq(ANN), eq("mention"), anyString(), eq(SESSION_ID), isNull()))
                .thenReturn(new WakeDispatchService.WakeFireResult(true, firstRun, "submitted"));
        when(dispatch.fire(eq(JOHN), eq("mention"), anyString(), eq(SESSION_ID), isNull()))
                .thenReturn(new WakeDispatchService.WakeFireResult(false, null, "skipped_muted"));

        fanOut.fanOut(SESSION_ID, "ws-1", "owner-1", ROOT_RUN.toString(), "@Ann @John", roster());
        // Serial invariant: John cannot have fired while Ann's run is still in flight.
        org.mockito.Mockito.verify(dispatch, org.mockito.Mockito.times(0))
                .fire(eq(JOHN), eq("mention"), anyString(), eq(SESSION_ID), isNull());
        long deadline = System.currentTimeMillis() + 2000;
        while (!fanOut.isAwaiting(firstRun.toString()) && System.currentTimeMillis() < deadline) {
            Thread.yield();
        }
        fanOut.onRunTerminalized(new ChatRunTerminalizedEvent(SESSION_ID.toString(),
                firstRun.toString(), "succeeded", "success"));
        verify(dispatch, timeout(2000)).fire(eq(JOHN), eq("mention"),
                eq("wake:mention:" + ROOT_RUN), eq(SESSION_ID), isNull());
    }

    @Test
    void timedOutWaitStillContinuesToTheNextRecipient() {
        when(config.resolve(eq("agent-runtime"), eq("wakeDispatchWaitSeconds"), any(), any()))
                .thenReturn("1");
        UUID hangingRun = UUID.randomUUID();
        when(dispatch.fire(eq(ANN), eq("mention"), anyString(), eq(SESSION_ID), isNull()))
                .thenReturn(new WakeDispatchService.WakeFireResult(true, hangingRun, "submitted"));
        when(dispatch.fire(eq(JOHN), eq("mention"), anyString(), eq(SESSION_ID), isNull()))
                .thenReturn(new WakeDispatchService.WakeFireResult(false, null, "skipped_muted"));

        fanOut.fanOut(SESSION_ID, "ws-1", "owner-1", ROOT_RUN.toString(), "@Ann @John", roster());

        // Q3: the round survives the timeout — John still fires after Ann's run never settles.
        verify(dispatch, timeout(10_000)).fire(eq(JOHN), eq("mention"),
                eq("wake:mention:" + ROOT_RUN), eq(SESSION_ID), isNull());
    }
}
