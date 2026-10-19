package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0536 barrier semantics that do not need a running server: arming
 * isolation, release idempotency, timeout cleanup and pass-through behaviour.
 */
class E2eGuidanceBarrierTest {

    private final E2eGuidanceBarrier barrier = new E2eGuidanceBarrier();

    @AfterEach
    void clear() {
        barrier.clearAll();
    }

    @Test
    void passThroughReturnsImmediatelyWhenNoBarrierIsArmed() {
        long started = System.nanoTime();
        barrier.passThrough(UUID.randomUUID());
        long elapsedMs = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - started);
        assertTrue(elapsedMs < 1_000, "unarmed pass-through must not block: " + elapsedMs + "ms");
    }

    @Test
    void barrierIsScopedToOneRun() throws Exception {
        UUID armedRun = UUID.randomUUID();
        UUID otherRun = UUID.randomUUID();
        barrier.arm(armedRun, "host-1", 5_000);

        // Another run must not be held by this barrier.
        barrier.passThrough(otherRun);

        CompletableFuture<Void> held = CompletableFuture.runAsync(() -> barrier.passThrough(armedRun));
        awaitState(armedRun, "host-1", "reached");
        assertFalse(held.isDone(), "the armed run must be held until release");

        assertTrue(barrier.release(armedRun, "host-1"));
        held.get(2, TimeUnit.SECONDS);
    }

    @Test
    void secondArmOnSameRunConflicts() {
        UUID run = UUID.randomUUID();
        barrier.arm(run, "host-1", 1_000);
        CpApiException conflict = assertThrows(CpApiException.class,
                () -> barrier.arm(run, "host-1", 1_000));
        assertEquals("E2E_BARRIER_ALREADY_ARMED", conflict.getCode());
    }

    @Test
    void releaseIsIdempotentAndRemovesTheBarrier() {
        UUID run = UUID.randomUUID();
        barrier.arm(run, "host-1", 1_000);
        assertTrue(barrier.release(run, "host-1"));
        assertFalse(barrier.release(run, "host-1"), "second release must report nothing to do");
        assertEquals(0, barrier.activeBarriers());
        Map<String, Object> status = barrier.status(run, "host-1");
        assertEquals("absent", status.get("state"));
    }

    @Test
    void statusReportsAbsentForForeignRunId() {
        UUID run = UUID.randomUUID();
        barrier.arm(run, "host-1", 1_000);
        assertEquals("absent", barrier.status(run, "host-2").get("state"));
        assertEquals("armed", barrier.status(run, "host-1").get("state"));
    }

    @Test
    void timeoutFailsExplicitlyAndDropsTheBarrier() {
        UUID run = UUID.randomUUID();
        barrier.arm(run, "host-1", 1);
        CpApiException timeout = assertThrows(CpApiException.class, () -> barrier.passThrough(run));
        assertEquals(E2eGuidanceBarrier.ERROR_TIMEOUT, timeout.getCode());
        assertEquals(503, timeout.getStatus().value());
        assertEquals(0, barrier.activeBarriers(), "a timed-out barrier must not linger");
    }

    @Test
    void holdIsClampedToTheDeclaredMaximum() {
        UUID run = UUID.randomUUID();
        barrier.arm(run, "host-1", E2eGuidanceBarrier.MAX_HOLD_MS * 10);
        assertEquals("armed", barrier.status(run, "host-1").get("state"));
        barrier.release(run, "host-1");
    }

    private void awaitState(UUID run, String e2eRunId, String expected) throws InterruptedException {
        for (int attempt = 0; attempt < 200; attempt++) {
            if (expected.equals(barrier.status(run, e2eRunId).get("state"))) {
                return;
            }
            Thread.sleep(10);
        }
        throw new AssertionError("barrier did not reach " + expected);
    }
}
