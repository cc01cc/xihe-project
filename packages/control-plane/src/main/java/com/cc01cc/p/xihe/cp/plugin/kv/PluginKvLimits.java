package com.cc01cc.p.xihe.cp.plugin.kv;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

/**
 * PLAN-0691 T1.5: plugin KV quota / limit values (spec/data-plane.md §2 QUOTA-1..QUOTA-13 and
 * §2.1 property names).
 *
 * <p>Every number here is copied from spec §2 and may not be tuned locally: the "default" is the
 * spec's low value, {@code HARD_*} is the spec's high value, and startup enforces
 * {@code configured <= hard} fail-fast (spec §2.1, last line). Exceeding the hard cap is therefore a
 * boot failure, never a runtime 429.
 *
 * <p>The env variable is spelled out as the placeholder default rather than left to relaxed binding:
 * {@code SystemEnvironmentPropertySource} maps {@code .} to {@code _} but not {@code -} to
 * {@code _}, so {@code cp.plugin.kv.max-keys} alone would never find
 * {@code XIHE_CP_PLUGIN_KV_MAX_KEYS}. This is exactly the form spec §2.1 prescribes
 * ({@code cp.plugin.<组>.<key>=${XIHE_CP_PLUGIN_<组>_<KEY>:<默认>}}).
 *
 * <p>QUOTA-13 ({@code statement_timeout=5s} / {@code lock_timeout=3s} Python-side DB session knobs)
 * is not wired here: plugins never get a database session in M1 (verify.md V1 forbids direct DB
 * access), so the value would have no consumer. Declared as a gap instead of a silent no-op.
 */
@Component
public class PluginKvLimits {

    /** QUOTA-1 hard cap: {@code kv.maxKeys} 10000 (default) / 20000 (hard). */
    static final int HARD_MAX_KEYS = 20_000;
    /** QUOTA-2 hard cap: {@code kv.maxValueBytes} 65536 (default) / 262144 (hard). */
    static final int HARD_MAX_VALUE_BYTES = 262_144;
    /** QUOTA-3 hard cap: {@code kv.ttlSecondsMax} 2592000 (default) / 7776000 (hard). */
    static final int HARD_TTL_SECONDS_MAX = 7_776_000;
    /** QUOTA-4 hard cap: {@code kv} rate 120 req/min (default) / 600 (hard). */
    static final int HARD_RATE_PER_MINUTE = 600;
    /**
     * QUOTA-4 gives no hard cap for the burst window itself, only the 600/min hard rate. A burst
     * larger than the whole per-minute budget would be self-contradictory, so the per-minute hard
     * cap doubles as the burst ceiling; this is a sanity guard, not a second quota number.
     */
    static final int HARD_RATE_BURST = HARD_RATE_PER_MINUTE;
    /** QUOTA-5 hard cap: concurrency 8 (default) / 32 (hard). */
    static final int HARD_RATE_CONCURRENCY = 32;

    private final int maxKeys;
    private final int maxValueBytes;
    private final int ttlSecondsMax;
    private final int ratePerMinute;
    private final int rateBurst;
    private final int rateConcurrency;

    public PluginKvLimits(
            @Value("${cp.plugin.kv.max-keys:${XIHE_CP_PLUGIN_KV_MAX_KEYS:10000}}") int maxKeys,
            @Value("${cp.plugin.kv.max-value-bytes:${XIHE_CP_PLUGIN_KV_MAX_VALUE_BYTES:65536}}") int maxValueBytes,
            @Value("${cp.plugin.kv.ttl-seconds-max:${XIHE_CP_PLUGIN_KV_TTL_SECONDS_MAX:2592000}}") int ttlSecondsMax,
            @Value("${cp.plugin.rate.per-min:${XIHE_CP_PLUGIN_RATE_PER_MIN:120}}") int ratePerMinute,
            @Value("${cp.plugin.rate.burst:${XIHE_CP_PLUGIN_RATE_BURST:20}}") int rateBurst,
            @Value("${cp.plugin.rate.concurrency:${XIHE_CP_PLUGIN_RATE_CONCURRENCY:8}}") int rateConcurrency) {
        this.maxKeys = requireWithin("cp.plugin.kv.max-keys", maxKeys, HARD_MAX_KEYS);
        this.maxValueBytes = requireWithin("cp.plugin.kv.max-value-bytes", maxValueBytes, HARD_MAX_VALUE_BYTES);
        this.ttlSecondsMax = requireWithin("cp.plugin.kv.ttl-seconds-max", ttlSecondsMax, HARD_TTL_SECONDS_MAX);
        this.ratePerMinute = requireWithin("cp.plugin.rate.per-min", ratePerMinute, HARD_RATE_PER_MINUTE);
        this.rateBurst = requireWithin("cp.plugin.rate.burst", rateBurst, HARD_RATE_BURST);
        this.rateConcurrency = requireWithin("cp.plugin.rate.concurrency", rateConcurrency, HARD_RATE_CONCURRENCY);
    }

    /** spec §2.1: {@code env <= 上限} is checked at startup and fails fast when violated. */
    private static int requireWithin(String name, int value, int hardCap) {
        if (value < 1 || value > hardCap) {
            throw new IllegalStateException(
                    "PLAN-0691: " + name + "=" + value + " is outside 1.." + hardCap
                            + " (spec/data-plane.md §2 hard cap); fix the deployment env, "
                            + "the hard cap is frozen until M2 review");
        }
        return value;
    }

    /** QUOTA-1: max live keys per binding. */
    public int maxKeys() {
        return maxKeys;
    }

    /** QUOTA-2: max serialised UTF-8 size of one value. */
    public int maxValueBytes() {
        return maxValueBytes;
    }

    /** QUOTA-3: max {@code ttlSeconds} accepted on write. */
    public int ttlSecondsMax() {
        return ttlSecondsMax;
    }

    /** QUOTA-4: sustained request budget per binding per minute. */
    public int ratePerMinute() {
        return ratePerMinute;
    }

    /** QUOTA-4: burst window size per binding. */
    public int rateBurst() {
        return rateBurst;
    }

    /** QUOTA-5: max in-flight requests per binding. */
    public int rateConcurrency() {
        return rateConcurrency;
    }
}
