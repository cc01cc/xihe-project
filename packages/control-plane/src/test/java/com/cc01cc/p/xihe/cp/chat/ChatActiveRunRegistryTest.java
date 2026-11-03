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

    @Test
    void unknownRunsAndSessionsReportNoActivity() {
        assertFalse(registry.isRunActiveLocally("missing"));
        assertFalse(registry.isRunActiveLocally(null));
        assertFalse(registry.hasActive("missing"));
        assertEquals(Set.of(), registry.activeRunIds("missing"));
    }
}
