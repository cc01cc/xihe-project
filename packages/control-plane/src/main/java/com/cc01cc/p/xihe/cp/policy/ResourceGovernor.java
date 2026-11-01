package com.cc01cc.p.xihe.cp.policy;

import com.cc01cc.p.xihe.cp.config.ResourceExhaustedException;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import java.time.Duration;
import java.time.Instant;
import java.util.Iterator;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

/**
 * PLAN-0622 M1.5 (design §3.1): one governor for every finite resource, instead of a per-feature
 * limiter per resource class.
 *
 * <p><b>In-memory by design.</b> The counters are a runtime admission decision, not durable state:
 * a restart resets them, and no table/cleanup path is introduced for them (膨胀门). Slots are
 * released on the terminal path of the work that borrowed them; a slot whose borrower never reports
 * a terminal state is reclaimed when its lease expires, so a crash degrades to "the limit heals
 * after the lease TTL" instead of "the limit is permanently exhausted".</p>
 *
 * <p>Admission never blocks and never queues: a refusal is a {@code 429 RESOURCE_EXHAUSTED} with a
 * {@code Retry-After} hint (checklist R1/R2/R6/R7). {@link #release} is idempotent — releasing an
 * unknown or already released lease is a no-op, so a success callback and a cancel callback that
 * both fire can never drive the outstanding count negative (R3).</p>
 */
@Component
public class ResourceGovernor {

    private static final Logger logger = LoggerFactory.getLogger(ResourceGovernor.class);

    /** One borrowed slot. {@code expiresAt} is the crash-safety net, not the normal release path. */
    public record Lease(ResourceKey key, UUID id, Instant expiresAt) {

        public Lease {
            if (key == null || id == null || expiresAt == null) {
                throw new IllegalArgumentException("A governor lease needs a key, an id and an expiry");
            }
        }
    }

    private static final class Slot {
        private final Map<UUID, Instant> outstanding = new java.util.LinkedHashMap<>();
        private Instant windowStart;
        private long windowTokens;

        private void purgeExpired(Instant now) {
            Iterator<Map.Entry<UUID, Instant>> iterator = outstanding.entrySet().iterator();
            while (iterator.hasNext()) {
                if (!iterator.next().getValue().isAfter(now)) {
                    iterator.remove();
                }
            }
        }

        private Instant earliestExpiry() {
            Instant earliest = null;
            for (Instant expiry : outstanding.values()) {
                if (earliest == null || expiry.isBefore(earliest)) {
                    earliest = expiry;
                }
            }
            return earliest;
        }
    }

    private final Map<ResourceKey, Slot> slots = new ConcurrentHashMap<>();
    private final java.time.Clock clock;

    public ResourceGovernor() {
        this(java.time.Clock.systemUTC());
    }

    /** Test seam: lets the suite advance time instead of sleeping. */
    ResourceGovernor(java.time.Clock clock) {
        this.clock = clock;
    }

    /**
     * Admit one unit of work, or refuse with {@code 429 RESOURCE_EXHAUSTED}.
     *
     * <p>Callers must invoke this <b>before</b> persisting anything for the work (checklist R2:
     * a refused request must not leave a row behind).</p>
     *
     * @param ttl how long the slot may stay borrowed without a {@link #release}; pass the lifetime
     *            of the thing that borrowed it (for a credential lease, the lease TTL)
     */
    public Lease tryAcquire(ResourceKey key, LimitSpec limit, Duration ttl) {
        if (key == null || limit == null) {
            throw new IllegalArgumentException("A resource key and a limit spec are required");
        }
        Duration effectiveTtl = ttl == null || ttl.isNegative() || ttl.isZero() ? Duration.ofSeconds(1) : ttl;
        Instant now = clock.instant();
        Slot slot = slots.computeIfAbsent(key, ignored -> new Slot());
        synchronized (slot) {
            slot.purgeExpired(now);
            int outstanding = slot.outstanding.size();
            if (limit.hasInflightCeiling() && outstanding >= limit.maxInflight()) {
                throw new ResourceExhaustedException(key, retryAfter(slot, limit, now),
                        "The " + key.kind() + " resource is at its concurrency limit (" + limit.maxInflight()
                                + "); retry after the Retry-After delay");
            }
            if (limit.hasQueueCeiling() && outstanding >= limit.maxQueue()) {
                throw new ResourceExhaustedException(key, retryAfter(slot, limit, now),
                        "The " + key.kind() + " resource queue is full (" + limit.maxQueue()
                                + "); admission is refused rather than queued");
            }
            if (limit.hasTokenWindow()) {
                resetWindowIfElapsed(slot, limit, now);
                if (slot.windowTokens >= limit.windowTokenBudget()) {
                    throw new ResourceExhaustedException(key, retryAfter(slot, limit, now),
                            "The " + key.kind() + " token budget for the current window is exhausted");
                }
            }
            UUID leaseId = UUID.randomUUID();
            Instant expiresAt = now.plus(effectiveTtl);
            slot.outstanding.put(leaseId, expiresAt);
            return new Lease(key, leaseId, expiresAt);
        }
    }

    /** Idempotent: an unknown or already released lease is a no-op, never a negative counter. */
    public void release(Lease lease) {
        if (lease == null) {
            return;
        }
        Slot slot = slots.get(lease.key());
        if (slot == null) {
            return;
        }
        synchronized (slot) {
            if (slot.outstanding.remove(lease.id()) != null) {
                logger.debug("[GOVERNOR] event=lease_released key={}", lease.key());
            }
        }
    }

    /** Records consumed tokens against the key's current window (no-op without a configured window). */
    public void recordTokens(ResourceKey key, long tokens) {
        if (key == null || tokens <= 0) {
            return;
        }
        Instant now = clock.instant();
        Slot slot = slots.computeIfAbsent(key, ignored -> new Slot());
        synchronized (slot) {
            if (slot.windowStart == null) {
                slot.windowStart = now;
            }
            slot.windowTokens += tokens;
        }
    }

    /** Outstanding (non-expired) borrows for one key; used by tests and diagnostics. */
    public int inflight(ResourceKey key) {
        if (key == null) {
            return 0;
        }
        Slot slot = slots.get(key);
        if (slot == null) {
            return 0;
        }
        synchronized (slot) {
            slot.purgeExpired(clock.instant());
            return slot.outstanding.size();
        }
    }

    private static void resetWindowIfElapsed(Slot slot, LimitSpec limit, Instant now) {
        if (slot.windowStart == null) {
            slot.windowStart = now;
            return;
        }
        if (!now.isBefore(slot.windowStart.plusSeconds(limit.windowSeconds()))) {
            slot.windowStart = now;
            slot.windowTokens = 0;
        }
    }

    private static int retryAfter(Slot slot, LimitSpec limit, Instant now) {
        Instant candidate = slot.earliestExpiry();
        if (candidate != null) {
            long seconds = Duration.between(now, candidate).toSeconds();
            return (int) Math.max(1, Math.min(seconds, 86_400));
        }
        if (limit.hasTokenWindow() && slot.windowStart != null) {
            long seconds = Duration.between(now, slot.windowStart.plusSeconds(limit.windowSeconds())).toSeconds();
            return (int) Math.max(1, Math.min(seconds, 86_400));
        }
        return 1;
    }
}
