package com.cc01cc.p.xihe.cp.chat;

import org.junit.jupiter.api.Test;

import java.util.Set;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0645 D45-02: one Session may drive several Runs, so the registry holds a set per Session —
 * and the Follow-up queue's serialization token lives beside it, never inside it.
 */
class ChatActiveRunRegistryTest {

    private static final String SESSION = "session-1";

    private final ChatActiveRunRegistry registry = new ChatActiveRunRegistry();

    @Test
    void severalRunsOfTheSameSessionCanBeActiveAtOnce() {
        assertTrue(registry.claim(SESSION, "run-1"));
        assertTrue(registry.claim(SESSION, "run-2"));

        assertEquals(Set.of("run-1", "run-2"), registry.activeRunIds(SESSION));
        assertTrue(registry.hasActive(SESSION));
        assertTrue(registry.isRunActiveLocally("run-1"));
        assertTrue(registry.isRunActiveLocally("run-2"));
    }

    @Test
    void claimingTheSameRunTwiceIsIdempotent() {
        assertTrue(registry.claim(SESSION, "run-1"));
        assertFalse(registry.claim(SESSION, "run-1"));
        assertEquals(Set.of("run-1"), registry.activeRunIds(SESSION));
    }

    @Test
    void releasingOneRunKeepsItsSiblingActive() {
        registry.claim(SESSION, "run-1");
        registry.claim(SESSION, "run-2");

        assertTrue(registry.release(SESSION, "run-1"));

        assertEquals(Set.of("run-2"), registry.activeRunIds(SESSION));
        assertTrue(registry.hasActive(SESSION));
        assertFalse(registry.isRunActiveLocally("run-1"));
        assertFalse(registry.release(SESSION, "run-1"), "releasing twice is a no-op");
    }

    @Test
    void releasingTheLastRunClearsTheSession() {
        registry.claim(SESSION, "run-1");

        assertTrue(registry.release(SESSION, "run-1"));

        assertFalse(registry.hasActive(SESSION));
        assertEquals(Set.of(), registry.activeRunIds(SESSION));
        assertFalse(registry.release(SESSION, "run-1"));
    }

    @Test
    void aRestartedRunCountsAsLocallyActiveInputButNotAsAClaim() {
        registry.restore(SESSION, "run-restored");

        assertTrue(registry.isRunActiveLocally("run-restored"));
        assertTrue(registry.hasActive(SESSION));
        assertFalse(registry.claim(SESSION, "run-restored"),
                "a claim on a restored run reports the existing entry instead of double-counting");
    }

    @Test
    void recoveryRestoresEveryInFlightRunOfOneSession() {
        registry.restore(SESSION, "run-a");
        registry.restore(SESSION, "run-b");

        assertEquals(Set.of("run-a", "run-b"), registry.activeRunIds(SESSION));
    }

    @Test
    void queueReservationIsIndependentFromTheRunSet() {
        assertTrue(registry.tryReserve("follow-up-queue:" + SESSION, "token-1"));
        assertFalse(registry.tryReserve("follow-up-queue:" + SESSION, "token-2"),
                "one admission at a time per queue");
        assertFalse(registry.hasActive(SESSION), "the queue reservation is not a run");
        assertTrue(registry.ownsReservation("follow-up-queue:" + SESSION, "token-1"));
        assertFalse(registry.ownsReservation("follow-up-queue:" + SESSION, "token-2"));

        assertTrue(registry.releaseReservation("follow-up-queue:" + SESSION, "token-1"));
        assertTrue(registry.tryReserve("follow-up-queue:" + SESSION, "token-2"));
    }

    // ── task-131: a parked run still counts as in flight, but the recovery drain may take it back ──

    @Test
    void aHandedOffRunStaysInFlightForItsOtherReaders() {
        assertTrue(registry.claim(SESSION, "run-parked"));
        assertTrue(registry.markHandedOff(SESSION, "run-parked"));

        // The two guard-shaped readers must not change: a parked run still blocks compaction and
        // must still be protected from reconciliation (releasing the claim would break both).
        assertTrue(registry.hasActive(SESSION));
        assertTrue(registry.isRunActiveLocally("run-parked"));
        assertTrue(registry.isHandedOff("run-parked"));
        assertEquals(Set.of("run-parked"), registry.activeRunIds(SESSION));
    }

    @Test
    void theRecoveryDrainTakesBackAParkedRunButNotAnActivelyDrivenOne() {
        registry.claim(SESSION, "run-parked");
        registry.markHandedOff(SESSION, "run-parked");

        assertTrue(registry.resumeHandedOff(SESSION, "run-parked"),
                "the drain may take back the run this process parked");
        assertFalse(registry.isHandedOff("run-parked"), "taking it back clears the parked mark");
        assertFalse(registry.resumeHandedOff(SESSION, "run-parked"),
                "a second dispatch of the same run is still refused");

        registry.claim(SESSION, "run-active");
        assertFalse(registry.resumeHandedOff(SESSION, "run-active"),
                "a run that is genuinely being driven is not a handoff");
    }

    @Test
    void releasingAParkedRunForgetsTheParkedMarkToo() {
        registry.claim(SESSION, "run-parked");
        registry.markHandedOff(SESSION, "run-parked");

        assertTrue(registry.release(SESSION, "run-parked"));

        assertFalse(registry.isHandedOff("run-parked"));
        assertFalse(registry.isRunActiveLocally("run-parked"));
        assertTrue(registry.resumeHandedOff(SESSION, "run-reused"),
                "a run this process no longer holds (registry lost, queue kept) is claimed defensively");
    }

    @Test
    void handingOffARunThisProcessDoesNotHoldIsARefusal() {
        assertFalse(registry.markHandedOff(SESSION, "run-unknown"),
                "only a run this process claimed can be parked for recovery");
        assertFalse(registry.isHandedOff("run-unknown"));
    }

    @Test
    void unknownRunsAndSessionsReportNoActivity() {
        assertFalse(registry.isRunActiveLocally("missing"));
        assertFalse(registry.isRunActiveLocally(null));
        assertFalse(registry.hasActive("missing"));
        assertEquals(Set.of(), registry.activeRunIds("missing"));
    }
}
