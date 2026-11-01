package com.cc01cc.p.xihe.cp.policy;

import com.cc01cc.p.xihe.cp.config.ResourceExhaustedException;
import org.junit.jupiter.api.Test;

import java.time.Duration;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

/**
 * PLAN-0622 D28: run-scoped slot bookkeeping.
 *
 * <p>The chat admission path borrows the slots on the request thread but the terminal state is
 * committed by a different thread (stream end, cancellation, reconciliation, restart recovery), so
 * the leases are indexed by run id. These assertions cover the two properties that makes that safe:
 * binding shows up in {@code inflight}, and releasing by id is idempotent — a cancellation callback
 * racing the stream terminal must never drive the outstanding count negative (R3).</p>
 */
class ResourceGovernorRunSlotsTest {

    private static final LimitSpec ONE_INFLIGHT = new LimitSpec(1, null, null, null);

    @Test
    void boundSlotsCountAgainstTheKeyUntilTheRunIsReleased() {
        ResourceGovernor governor = new ResourceGovernor();
        ResourceKey key = ResourceKey.connection("conn-1");
        ResourceGovernor.Lease lease = governor.tryAcquire(key, ONE_INFLIGHT, Duration.ofMinutes(5));

        assertEquals(1, governor.inflight(key), "the borrow is visible immediately");
        governor.bindToRun("run-1", List.of(lease));
        assertEquals(1, governor.inflightForRun("run-1"));

        assertEquals(0, governor.inflightForRun("run-unknown"), "unknown run holds nothing");
        governor.releaseRun("run-unknown");
        assertEquals(1, governor.inflight(key), "releasing an unknown run is a no-op");

        governor.releaseRun("run-1");
        assertEquals(0, governor.inflight(key), "the terminal path frees the ceiling");
        assertEquals(0, governor.inflightForRun("run-1"));

        governor.releaseRun("run-1");
        assertEquals(0, governor.inflight(key), "release is idempotent (R3)");
    }

    @Test
    void aSecondRunIsRefusedWhileTheFirstRunHoldsTheOnlySlot() {
        ResourceGovernor governor = new ResourceGovernor();
        ResourceKey key = ResourceKey.connection("conn-1");
        governor.bindToRun("run-1",
                List.of(governor.tryAcquire(key, ONE_INFLIGHT, Duration.ofMinutes(5))));

        ResourceExhaustedException refused = assertThrows(ResourceExhaustedException.class,
                () -> governor.tryAcquire(key, ONE_INFLIGHT, Duration.ofMinutes(5)));
        assertEquals("CONNECTION", refused.getResourceKind());
        assertEquals("connection:conn-1", refused.getScope());
        assertEquals(429, refused.getStatus().value());

        governor.releaseRun("run-1");
        assertEquals(0, governor.inflight(key), "the ceiling admits again after the release");
        ResourceGovernor.Lease admittedAgain =
                governor.tryAcquire(key, ONE_INFLIGHT, Duration.ofMinutes(5));
        assertEquals(1, governor.inflight(key));
        governor.release(admittedAgain);
    }

    @Test
    void bindingMergesInsteadOfReplacingTheRunSlots() {
        ResourceGovernor governor = new ResourceGovernor();
        ResourceKey connectionKey = ResourceKey.connection("conn-1");
        ResourceKey modelKey = ResourceKey.model("conn-1", "openai", "gpt-4o");

        governor.bindToRun("run-1", List.of(governor.tryAcquire(connectionKey, ONE_INFLIGHT,
                Duration.ofMinutes(5))));
        governor.bindToRun("run-1", List.of(governor.tryAcquire(modelKey, ONE_INFLIGHT,
                Duration.ofMinutes(5))));

        assertEquals(2, governor.inflightForRun("run-1"));
        governor.releaseRun("run-1");
        assertEquals(0, governor.inflight(connectionKey));
        assertEquals(0, governor.inflight(modelKey), "both borrowed slots are freed");
    }

    @Test
    void expiredSlotsAreReclaimedEvenWithoutAnExplicitRelease() throws InterruptedException {
        ResourceGovernor governor = new ResourceGovernor();
        ResourceKey key = ResourceKey.connection("conn-1");
        governor.bindToRun("run-1",
                List.of(governor.tryAcquire(key, ONE_INFLIGHT, Duration.ofMillis(1))));
        Thread.sleep(20);

        // No release reached the governor: the crash-safety net is the slot TTL (R5).
        assertEquals(0, governor.inflight(key));
        ResourceGovernor.Lease admittedAgain = governor.tryAcquire(key, ONE_INFLIGHT, Duration.ofMinutes(5));
        assertEquals(1, governor.inflight(key));
        governor.release(admittedAgain);
    }

    @Test
    void aRunThatNeverTerminatesIsForgottenWhenItsSlotsExpire() {
        MutableClock clock = new MutableClock(java.time.Instant.parse("2026-11-02T00:00:00Z"));
        ResourceGovernor governor = new ResourceGovernor(clock);
        ResourceKey key = ResourceKey.connection("conn-1");
        governor.bindToRun("stuck-run",
                List.of(governor.tryAcquire(key, ONE_INFLIGHT, Duration.ofMinutes(10))));
        assertEquals(1, governor.inflightForRun("stuck-run"));

        clock.advance(Duration.ofMinutes(11));

        assertEquals(0, governor.inflightForRun("stuck-run"),
                "the bookkeeping entry must not outlive its slots (bounded map)");
        assertEquals(0, governor.inflight(key));
    }

    /** Test seam mirroring the governor's package-private clock constructor. */
    private static final class MutableClock extends java.time.Clock {

        private java.time.Instant now;

        private MutableClock(java.time.Instant start) {
            this.now = start;
        }

        private void advance(Duration by) {
            now = now.plus(by);
        }

        @Override
        public java.time.ZoneId getZone() {
            return java.time.ZoneOffset.UTC;
        }

        @Override
        public java.time.Clock withZone(java.time.ZoneId zone) {
            return this;
        }

        @Override
        public java.time.Instant instant() {
            return now;
        }
    }
}
