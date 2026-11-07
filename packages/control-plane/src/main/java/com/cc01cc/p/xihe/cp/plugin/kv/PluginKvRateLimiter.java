package com.cc01cc.p.xihe.cp.plugin.kv;

import org.springframework.stereotype.Component;

import java.util.Iterator;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;

/**
 * PLAN-0691 T1.5: per-binding rate and concurrency gate for the KV data plane
 * (spec/data-plane.md §2 末条: 「限流按 binding 维度在 CP 进程内滑动窗口 + 信号量实现」).
 *
 * <p>Implementation choice, and the simpler alternative that was rejected:
 * {@code cp/policy} already has a resource governor with a {@code ResourceKey.Kind} enum, but that
 * enum is frozen at six storage kinds with no {@code RATE} member, and {@code policy/**} is out of
 * this task's scope. Reusing it would mean widening a frozen vocabulary to describe a plugin-only
 * concern. So this class is a token bucket (the sliding-window budget, refilled continuously instead
 * of in per-minute steps so a burst at a minute boundary cannot double-spend) plus an in-flight
 * counter (the semaphore), local to the plugin KV package.
 *
 * <p>Scope is one CP process. §2 already states multi-instance deployments divide the budget by
 * instance count (M2 review), so the budget here is deliberately <em>not</em> shared across
 * processes: pretending to be global with no shared store would be worse than the documented
 * per-process semantics.
 *
 * <p>Buckets live in a map keyed by binding id. That is bounded work, not unbounded growth: entries
 * are one small object per binding ever seen, and once the map passes
 * {@value #IDLE_EVICT_THRESHOLD} entries an acquire sweeps entries that have been idle for ten
 * minutes and have no request in flight.
 */
@Component
public class PluginKvRateLimiter {

    /** Start sweeping idle buckets once the map grows past this many bindings. */
    static final int IDLE_EVICT_THRESHOLD = 2_048;
    /** A bucket idle this long with nothing in flight is safe to drop (limits are time-based). */
    static final long IDLE_EVICT_NANOS = TimeUnit.MINUTES.toNanos(10);

    private final double refillPerSecond;
    private final double burst;
    private final int concurrency;
    private final ConcurrentHashMap<UUID, Bucket> buckets = new ConcurrentHashMap<>();

    public PluginKvRateLimiter(PluginKvLimits limits) {
        this.refillPerSecond = limits.ratePerMinute() / 60.0d;
        this.burst = limits.rateBurst();
        this.concurrency = limits.rateConcurrency();
    }

    /**
     * Takes one request slot for {@code bindingId}.
     *
     * @return a permit that must be closed (try-with-resources) to release the concurrency slot
     * @throws PluginKvRateLimitedException 429 {@code PLUGIN_RATE_LIMITED} when the budget or the
     *                                      concurrency limit is exhausted; the exception carries the
     *                                      {@code Retry-After} hint
     */
    public Permit acquire(UUID bindingId) {
        long now = System.nanoTime();
        if (buckets.size() > IDLE_EVICT_THRESHOLD) {
            evictIdle(now);
        }
        Bucket bucket = buckets.computeIfAbsent(bindingId, id -> new Bucket(burst, now));
        synchronized (bucket) {
            refill(bucket, now);
            if (bucket.inFlight >= concurrency) {
                throw new PluginKvRateLimitedException(1L, "plugin binding " + bindingId
                        + " already has " + concurrency + " concurrent KV requests (QUOTA-5)");
            }
            if (bucket.tokens < 1.0d) {
                long retryAfter = Math.max(1L, (long) Math.ceil((1.0d - bucket.tokens) / refillPerSecond));
                throw new PluginKvRateLimitedException(retryAfter, "plugin binding " + bindingId
                        + " exceeded its KV rate budget (QUOTA-4)");
            }
            bucket.tokens -= 1.0d;
            bucket.inFlight++;
            bucket.lastUsedNanos = now;
        }
        return new Permit(bucket);
    }

    /** Continuous refill: elapsed time turns into tokens, capped at the burst size. */
    private void refill(Bucket bucket, long now) {
        long elapsed = now - bucket.lastRefillNanos;
        if (elapsed <= 0) {
            return;
        }
        bucket.tokens = Math.min(burst, bucket.tokens + (elapsed / (double) TimeUnit.SECONDS.toNanos(1))
                * refillPerSecond);
        bucket.lastRefillNanos = now;
    }

    private void evictIdle(long now) {
        Iterator<Map.Entry<UUID, Bucket>> iterator = buckets.entrySet().iterator();
        while (iterator.hasNext()) {
            Bucket bucket = iterator.next().getValue();
            synchronized (bucket) {
                if (bucket.inFlight == 0 && now - bucket.lastUsedNanos > IDLE_EVICT_NANOS) {
                    iterator.remove();
                }
            }
        }
    }

    /** Concurrency slot for one request; closing it returns the slot exactly once. */
    public static final class Permit implements AutoCloseable {

        private final Bucket bucket;
        private boolean released;

        private Permit(Bucket bucket) {
            this.bucket = bucket;
        }

        @Override
        public void close() {
            synchronized (bucket) {
                if (!released) {
                    released = true;
                    bucket.inFlight--;
                }
            }
        }
    }

    private static final class Bucket {

        private double tokens;
        private long lastRefillNanos;
        private long lastUsedNanos;
        private int inFlight;

        private Bucket(double initialTokens, long now) {
            this.tokens = initialTokens;
            this.lastRefillNanos = now;
            this.lastUsedNanos = now;
        }
    }
}
