package com.cc01cc.p.xihe.cp.plugin.kv;

import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;

import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0691 T1.5 (verify.md V5): the quota numbers of {@code spec/data-plane.md} §2, tested with the
 * spec's own numbers.
 *
 * <p>Each assertion is a boundary, not a round number: 65536 bytes passes and 65537 is 413; the
 * 10001st key is 429 while 10000 are already stored; a TTL of 2592000 s is accepted and 2592001 is
 * 429; the 21st request inside one burst window is 429 with {@code Retry-After}. A test that only
 * asserted "some large value is rejected" would pass with any invented number — the exact edges are
 * the contract (spec §2 "所有数字变更必须同批改本表 + verify.md V5").
 *
 * <p>Two of the six checks are deliberately <b>not</b> HTTP-level, and the reason is written at each
 * site: filling 10000 keys through HTTP would be 10000 round-trips, and racing nine in-flight requests
 * through the wire is timing-dependent (a green run would not mean the semaphore works). The budget is
 * therefore pre-loaded with SQL and the semaphore is driven directly.
 */
class PluginKvQuotaTest extends AbstractPluginKvIntegrationTest {

    private static final String NS = "default";
    private static final int DEFAULT_MAX_KEYS = 10_000;
    private static final int DEFAULT_MAX_VALUE_BYTES = 65_536;
    private static final int DEFAULT_TTL_SECONDS_MAX = 2_592_000;
    private static final int DEFAULT_RATE_BURST = 20;
    private static final int DEFAULT_RATE_CONCURRENCY = 8;

    // ------------------------------------------------------------------ QUOTA-2: value bytes

    @Test
    void valueAtTheCeilingIsAccepted() {
        SeededBinding binding = seedEnabledBinding();

        ResponseEntity<String> accepted = put(kvPath(binding, NS + "/big"), token(binding),
                putBody(jsonStringOfBytes(DEFAULT_MAX_VALUE_BYTES)));

        assertEquals(HttpStatus.OK, accepted.getStatusCode(),
                "65536 bytes is the documented ceiling, so it must pass (QUOTA-2)");
    }

    @Test
    void valueOneByteOverTheCeilingIsPayloadTooLarge() {
        SeededBinding binding = seedEnabledBinding();

        ResponseEntity<String> rejected = put(kvPath(binding, NS + "/big"), token(binding),
                putBody(jsonStringOfBytes(DEFAULT_MAX_VALUE_BYTES + 1)));

        // RFC 9110 renamed 413 Payload Too Large -> Content Too Large; Spring 7 spells it that way.
        assertEquals(HttpStatus.CONTENT_TOO_LARGE, rejected.getStatusCode());
        assertEquals(PluginKvService.CODE_VALUE_TOO_LARGE, code(rejected));
        assertTrue(json(rejected).get("detail").asText().contains("65536"),
                "the 413 must name the configured limit: " + rejected.getBody());
    }

    // ------------------------------------------------------------------ QUOTA-1: key budget

    @Test
    void keyBudgetRejectsTheNextKeyAfterTenThousand() {
        SeededBinding binding = seedEnabledBinding();
        // Pre-loaded with SQL: 10000 HTTP round-trips would add minutes of wall clock and prove
        // nothing about the budget check, which counts live rows before an insert.
        List<Object[]> rows = new ArrayList<>(DEFAULT_MAX_KEYS);
        for (int index = 0; index < DEFAULT_MAX_KEYS; index++) {
            rows.add(new Object[] {binding.bindingId(), String.format("k%05d", index)});
        }
        jdbcTemplate.batchUpdate(
                "INSERT INTO plugin_kv (binding_id, namespace, key, value)"
                        + " VALUES (?, 'default', ?, '{}'::jsonb)", rows);
        assertEquals(DEFAULT_MAX_KEYS, liveKeys(binding.bindingId()));

        ResponseEntity<String> rejected = put(kvPath(binding, NS + "/overflow"), token(binding),
                putBody("{\"n\":1}"));

        assertEquals(HttpStatus.TOO_MANY_REQUESTS, rejected.getStatusCode());
        assertEquals(PluginKvService.CODE_QUOTA_EXCEEDED, code(rejected));
        assertEquals(DEFAULT_MAX_KEYS, liveKeys(binding.bindingId()),
                "a rejected write must not have added a row (QUOTA-1)");
    }

    @Test
    void overwritingAnExistingKeyDoesNotConsumeBudget() {
        SeededBinding binding = seedEnabledBinding();
        List<Object[]> rows = new ArrayList<>(DEFAULT_MAX_KEYS);
        for (int index = 0; index < DEFAULT_MAX_KEYS; index++) {
            rows.add(new Object[] {binding.bindingId(), String.format("k%05d", index)});
        }
        jdbcTemplate.batchUpdate(
                "INSERT INTO plugin_kv (binding_id, namespace, key, value)"
                        + " VALUES (?, 'default', ?, '{}'::jsonb)", rows);

        // The budget is a live-key count, not a write counter: updating a stored key stays allowed.
        ResponseEntity<String> updated = put(kvPath(binding, NS + "/k00000"), token(binding),
                putBody("{\"n\":1}"), "1");

        assertEquals(HttpStatus.OK, updated.getStatusCode(), updated.getBody());
    }

    // ------------------------------------------------------------------ QUOTA-3: TTL

    @Test
    void ttlAtTheCeilingIsAccepted() {
        SeededBinding binding = seedEnabledBinding();

        ResponseEntity<String> accepted = put(kvPath(binding, NS + "/ttl"), token(binding),
                putBody("{\"n\":1}", (long) DEFAULT_TTL_SECONDS_MAX, null));

        assertEquals(HttpStatus.OK, accepted.getStatusCode());
    }

    @Test
    void ttlOneSecondOverTheCeilingIsQuotaExceeded() {
        SeededBinding binding = seedEnabledBinding();

        ResponseEntity<String> rejected = put(kvPath(binding, NS + "/ttl"), token(binding),
                putBody("{\"n\":1}", DEFAULT_TTL_SECONDS_MAX + 1L, null));

        assertEquals(HttpStatus.TOO_MANY_REQUESTS, rejected.getStatusCode());
        assertEquals(PluginKvService.CODE_QUOTA_EXCEEDED, code(rejected));
    }

    // ------------------------------------------------------------------ QUOTA-4: rate

    @Test
    void theBurstWindowIsTwentyAndThenAnswersRetryAfter() {
        SeededBinding binding = seedEnabledBinding();
        String path = kvPath(binding, NS + "/missing");

        // A fresh binding starts with a full burst bucket (QUOTA-4: 120/min, burst 20). The upper
        // bound of the window is what is asserted; the lower bound allows for the continuous refill
        // (2 tokens/s) on a slow machine, which is why it is a range rather than an exact index.
        int firstRejection = 0;
        ResponseEntity<String> rejected = null;
        for (int request = 1; request <= 40 && rejected == null; request++) {
            ResponseEntity<String> response = get(path, token(binding));
            if (response.getStatusCode() == HttpStatus.TOO_MANY_REQUESTS) {
                firstRejection = request;
                rejected = response;
            } else {
                assertEquals(HttpStatus.NOT_FOUND, response.getStatusCode(),
                        "request " + request + " is inside the burst window");
            }
        }

        assertNotNull(rejected, "40 requests inside one second must exhaust a 20-request burst");
        assertTrue(firstRejection >= DEFAULT_RATE_BURST + 1,
                "the burst allows " + DEFAULT_RATE_BURST + " requests, rejected at " + firstRejection);
        assertTrue(firstRejection <= DEFAULT_RATE_BURST + 4,
                "refill is 2 tokens/s, so the window cannot stretch to " + firstRejection);
        assertEquals("PLUGIN_RATE_LIMITED", code(rejected),
                "rate exhaustion has its own code (API-11)");
        String retryAfter = rejected.getHeaders().getFirst("Retry-After");
        assertNotNull(retryAfter, "a 429 without Retry-After tells the client to hammer again");
        assertTrue(Integer.parseInt(retryAfter) >= 1, "Retry-After must be a positive second count");
        assertEquals("no-store", rejected.getHeaders().getFirst("Cache-Control"));
        assertEquals(Integer.parseInt(retryAfter),
                json(rejected).get("retryAfterSeconds").asInt());
    }

    // ------------------------------------------------------------------ QUOTA-5: concurrency

    @Test
    void theNinthConcurrentRequestIsRejected() {
        // Direct limiter, not HTTP: nine genuinely overlapping requests are a race, and a green
        // timing-dependent test would say nothing about the semaphore. Holding eight permits and
        // asking for a ninth is the exact condition the limit describes.
        PluginKvRateLimiter limiter = new PluginKvRateLimiter(defaultLimits());
        UUID bindingId = UUID.randomUUID();

        List<PluginKvRateLimiter.Permit> held = new ArrayList<>();
        try {
            for (int index = 0; index < DEFAULT_RATE_CONCURRENCY; index++) {
                held.add(limiter.acquire(bindingId));
            }

            PluginKvRateLimitedException rejected = assertThrows(PluginKvRateLimitedException.class,
                    () -> limiter.acquire(bindingId));
            assertEquals(HttpStatus.TOO_MANY_REQUESTS, rejected.getStatus());
            assertEquals("PLUGIN_RATE_LIMITED", rejected.getCode());
            assertTrue(rejected.retryAfterSeconds() >= 1);

            // Releasing one in-flight slot makes room again: the semaphore is not a leak.
            held.remove(held.size() - 1).close();
            held.add(limiter.acquire(bindingId));
        } finally {
            held.forEach(PluginKvRateLimiter.Permit::close);
        }
    }

    @Test
    void closingAPermitTwiceDoesNotDoubleRelease() {
        PluginKvRateLimiter limiter = new PluginKvRateLimiter(defaultLimits());
        UUID bindingId = UUID.randomUUID();
        List<PluginKvRateLimiter.Permit> held = new ArrayList<>();
        try {
            for (int index = 0; index < DEFAULT_RATE_CONCURRENCY; index++) {
                held.add(limiter.acquire(bindingId));
            }
            // Two in-flight slots released: one deliberately, one closed three times in total.
            held.remove(0).close();
            held.get(0).close();
            held.get(0).close();

            // Exactly two slots are free again. A double release would let a third through.
            held.add(limiter.acquire(bindingId));
            held.add(limiter.acquire(bindingId));
            assertThrows(PluginKvRateLimitedException.class, () -> limiter.acquire(bindingId),
                    "a repeated close must not hand out an extra slot");
        } finally {
            held.forEach(PluginKvRateLimiter.Permit::close);
        }
    }

    // ------------------------------------------------------------------ §2.1: hard caps

    @Test
    void configuredValueAboveTheHardCapFailsFast() {
        // spec §2.1: "M1 启动校验 env ≤ 上限，越界 fail-fast" — a boot failure, never a runtime 429.
        IllegalStateException failure = assertThrows(IllegalStateException.class,
                () -> new PluginKvLimits(20_001, DEFAULT_MAX_VALUE_BYTES, DEFAULT_TTL_SECONDS_MAX,
                        120, DEFAULT_RATE_BURST, DEFAULT_RATE_CONCURRENCY));
        assertTrue(failure.getMessage().contains("cp.plugin.kv.max-keys"),
                "the message must name the offending property: " + failure.getMessage());
        assertTrue(failure.getMessage().contains("hard cap"), failure.getMessage());
    }

    @Test
    void zeroOrNegativeLimitsAreRejectedToo() {
        assertThrows(IllegalStateException.class,
                () -> new PluginKvLimits(0, DEFAULT_MAX_VALUE_BYTES, DEFAULT_TTL_SECONDS_MAX,
                        120, DEFAULT_RATE_BURST, DEFAULT_RATE_CONCURRENCY));
    }

    // ------------------------------------------------------------------ helpers

    private static PluginKvLimits defaultLimits() {
        return new PluginKvLimits(DEFAULT_MAX_KEYS, DEFAULT_MAX_VALUE_BYTES, DEFAULT_TTL_SECONDS_MAX,
                120, DEFAULT_RATE_BURST, DEFAULT_RATE_CONCURRENCY);
    }

    /** A JSON string literal whose serialised UTF-8 length is exactly {@code bytes}. */
    private static String jsonStringOfBytes(int bytes) {
        return "\"" + "a".repeat(bytes - 2) + "\"";
    }

    private int liveKeys(UUID bindingId) {
        Integer count = jdbcTemplate.queryForObject(
                "SELECT count(*) FROM plugin_kv WHERE binding_id = ?", Integer.class, bindingId);
        return count == null ? 0 : count;
    }
}
