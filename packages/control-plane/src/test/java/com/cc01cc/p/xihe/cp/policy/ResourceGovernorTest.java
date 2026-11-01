package com.cc01cc.p.xihe.cp.policy;

import com.cc01cc.p.xihe.cp.config.ResourceExhaustedException;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneId;
import java.time.ZoneOffset;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0622 M1.5 (R1/R3/R5/R6/R7 + V8): the unified governor's contract, on a controllable clock
 * so expiry and window behaviour are deterministic without sleeping.
 */
class ResourceGovernorTest {

    private static final ResourceKey KEY = ResourceKey.connection("11111111-1111-4111-8111-111111111111");

    @Test
    void releaseIsIdempotentAndNeverDrivesTheCounterNegative() {
        MutableClock clock = new MutableClock();
        ResourceGovernor governor = new ResourceGovernor(clock);
        LimitSpec oneSlot = new LimitSpec(1, null, null, null);

        ResourceGovernor.Lease lease = governor.tryAcquire(KEY, oneSlot, Duration.ofMinutes(5));
        assertEquals(1, governor.inflight(KEY));
        governor.release(lease);
        governor.release(lease);
        governor.release(null);
        assertEquals(0, governor.inflight(KEY), "R3: double release is a no-op, never -1");
        ResourceGovernor.Lease second = governor.tryAcquire(KEY, oneSlot, Duration.ofMinutes(5));
        assertEquals(1, governor.inflight(KEY), "the slot is reusable after release");
        governor.release(second);
    }

    @Test
    void anInflightCeilingRefusesWithResourceExhaustedRatherThanABackendError() {
        MutableClock clock = new MutableClock();
        ResourceGovernor governor = new ResourceGovernor(clock);
        LimitSpec oneSlot = new LimitSpec(1, null, null, null);
        governor.tryAcquire(KEY, oneSlot, Duration.ofMinutes(5));

        ResourceExhaustedException refused = assertThrows(ResourceExhaustedException.class,
                () -> governor.tryAcquire(KEY, oneSlot, Duration.ofMinutes(5)));
        assertEquals(HttpStatus.TOO_MANY_REQUESTS, refused.getStatus(), "R7: 429, never 503");
        assertEquals("RESOURCE_EXHAUSTED", refused.getCode());
        assertTrue(refused.getRetryAfterSeconds() >= 1, "R6: a retry hint is always present");
        assertEquals("CONNECTION", refused.getResourceKind());
        assertEquals(KEY.scope(), refused.getScope());
        assertNotEquals(503, refused.getStatus().value());
    }

    @Test
    void theQueueCeilingFailsFastInsteadOfQueuing() {
        MutableClock clock = new MutableClock();
        ResourceGovernor governor = new ResourceGovernor(clock);

        assertThrows(ResourceExhaustedException.class,
                () -> governor.tryAcquire(KEY, new LimitSpec(null, 0, null, null), Duration.ofMinutes(5)),
                "maxQueue=0 refuses immediately: admission never queues");
    }

    @Test
    void anExpiredLeaseReclaimsTheSlotSoACrashIsNotPermanent() {
        MutableClock clock = new MutableClock();
        ResourceGovernor governor = new ResourceGovernor(clock);
        LimitSpec oneSlot = new LimitSpec(1, null, null, null);
        governor.tryAcquire(KEY, oneSlot, Duration.ofMinutes(5));

        clock.advance(Duration.ofMinutes(6));
        assertEquals(0, governor.inflight(KEY), "R5: an unreleased slot expires with its lease");
        ResourceGovernor.Lease reclaimed = governor.tryAcquire(KEY, oneSlot, Duration.ofMinutes(5));
        governor.release(reclaimed);
    }

    @Test
    void aTokenWindowRefusesAfterTheBudgetAndResetsWithTheWindow() {
        MutableClock clock = new MutableClock();
        ResourceGovernor governor = new ResourceGovernor(clock);
        LimitSpec budget = new LimitSpec(1, null, 100L, 60);

        ResourceGovernor.Lease lease = governor.tryAcquire(KEY, budget, Duration.ofMinutes(5));
        governor.release(lease);
        governor.recordTokens(KEY, 120L);
        assertThrows(ResourceExhaustedException.class,
                () -> governor.tryAcquire(KEY, budget, Duration.ofMinutes(5)),
                "the window budget is exhausted");

        clock.advance(Duration.ofSeconds(61));
        ResourceGovernor.Lease next = governor.tryAcquire(KEY, budget, Duration.ofMinutes(5));
        governor.release(next);
    }

    @Test
    void unconfiguredLimitsMeanUnlimited() {
        MutableClock clock = new MutableClock();
        ResourceGovernor governor = new ResourceGovernor(clock);
        for (int index = 0; index < 50; index++) {
            governor.tryAcquire(KEY, LimitSpec.UNLIMITED, Duration.ofMinutes(5));
        }
        assertEquals(50, governor.inflight(KEY), "NULL columns keep the pre-0622 behaviour");
    }

    @Test
    void aSessionScopedKeyIsRejected() {
        assertThrows(IllegalArgumentException.class,
                () -> new ResourceKey(ResourceKey.Kind.CONNECTION, "session:abc"),
                "V8: the session is never a concurrency limit");
        assertThrows(IllegalArgumentException.class,
                () -> new ResourceKey(ResourceKey.Kind.MODEL, "connection:x/provider/session:run"));
        assertEquals("connection:x/provider/m", ResourceKey.model("x", "provider", "m").scope());
    }

    /** Test clock: time only moves when the test says so. */
    private static final class MutableClock extends Clock {

        private Instant now = Instant.parse("2026-11-02T00:00:00Z");

        private void advance(Duration duration) {
            now = now.plus(duration);
        }

        @Override
        public ZoneId getZone() {
            return ZoneOffset.UTC;
        }

        @Override
        public Clock withZone(ZoneId zone) {
            return this;
        }

        @Override
        public Instant instant() {
            return now;
        }
    }
}
