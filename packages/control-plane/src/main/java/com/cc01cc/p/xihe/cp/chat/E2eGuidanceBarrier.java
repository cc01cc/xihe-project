package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.context.annotation.Profile;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Component;

import java.time.Instant;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

/**
 * PLAN-0536: E2E-only Guidance barrier. Frozen contract:
 * {@code plans/PLAN-0536-xh-guidance-race-error-e2e/spec/e2e-guidance-barrier.md}.
 *
 * <p>The barrier exists only to make one ordering deterministic: a browser
 * Guidance POST has reached CP, the Run is cancelled through the real endpoint,
 * and only then the POST continues into the unchanged production validation and
 * returns the frozen {@code 409 GUIDANCE_RUN_NOT_ACTIVE}.
 *
 * <p>It must stay outside {@link ChatRunGuidanceService}'s transaction. That
 * service locks the Session row and then the Run row, exactly like
 * {@link ChatRunCancellationService#claimCancellation}; pausing inside the
 * transaction would block the cancel on the same rows until
 * {@code cp.lock-timeout-ms} expires, so the race could never be produced.
 *
 * <p>Not a bean outside the {@code e2e} profile: nothing else can reach it, so
 * no production flag, header or management route exists.
 */
@Component
@Profile("e2e")
public class E2eGuidanceBarrier {

    private static final Logger logger = LoggerFactory.getLogger(E2eGuidanceBarrier.class);

    /** Upper bound for a held POST, so a forgotten release cannot pin a request thread. */
    static final long MAX_HOLD_MS = 60_000;

    static final String ERROR_TIMEOUT = "E2E_GUIDANCE_BARRIER_TIMEOUT";

    private enum State {
        ARMED,
        REACHED
    }

    private static final class Barrier {
        private final String e2eRunId;
        private final long holdMs;
        private final CompletableFuture<Void> released = new CompletableFuture<>();
        private volatile State state = State.ARMED;
        private volatile Instant reachedAt;

        private Barrier(String e2eRunId, long holdMs) {
            this.e2eRunId = e2eRunId;
            this.holdMs = holdMs;
        }
    }

    private final Map<UUID, Barrier> barriers = new ConcurrentHashMap<>();

    /** Declares one run-scoped barrier. A second arm for the same run is a conflict. */
    public void arm(UUID runId, String e2eRunId, long holdMs) {
        if (e2eRunId == null || e2eRunId.isBlank()) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "E2E_BARRIER_RUN_ID_REQUIRED",
                    "e2eRunId is required");
        }
        long bounded = Math.min(Math.max(holdMs, 1), MAX_HOLD_MS);
        Barrier barrier = new Barrier(e2eRunId, bounded);
        Barrier existing = barriers.putIfAbsent(runId, barrier);
        if (existing != null) {
            throw new CpApiException(HttpStatus.CONFLICT, "E2E_BARRIER_ALREADY_ARMED",
                    "A guidance barrier is already armed for this run");
        }
        logger.info("[E2E] service=cp event=guidance_barrier_armed runId={} e2eRunId={} holdMs={}",
                runId, e2eRunId, bounded);
    }

    /**
     * Snapshot of one barrier. Returns {@code absent} for an unknown run so the
     * spec can tell "never armed" from "already consumed".
     */
    public Map<String, Object> status(UUID runId, String e2eRunId) {
        Barrier barrier = barriers.get(runId);
        if (barrier == null || !barrier.e2eRunId.equals(e2eRunId)) {
            return Map.of("runId", runId.toString(), "e2eRunId", String.valueOf(e2eRunId),
                    "state", "absent");
        }
        String state = barrier.state == State.REACHED ? "reached" : "armed";
        if (barrier.released.isDone()) {
            state = "released";
        }
        Map<String, Object> body = new java.util.LinkedHashMap<>();
        body.put("runId", runId.toString());
        body.put("e2eRunId", barrier.e2eRunId);
        body.put("state", state);
        if (barrier.reachedAt != null) {
            body.put("reachedAt", barrier.reachedAt.toString());
        }
        return body;
    }

    /** Releases a barrier; idempotent for repeated calls and no-op when already gone. */
    public boolean release(UUID runId, String e2eRunId) {
        Barrier barrier = barriers.get(runId);
        if (barrier == null || !barrier.e2eRunId.equals(e2eRunId)) {
            return false;
        }
        barrier.released.complete(null);
        barriers.remove(runId, barrier);
        logger.info("[E2E] service=cp event=guidance_barrier_released runId={} e2eRunId={}",
                runId, e2eRunId);
        return true;
    }

    /**
     * Holds the calling request while a barrier is armed for this run.
     *
     * <p>Returns immediately when no barrier matches, which is the only state a
     * dev or prod profile could ever observe (the bean does not exist there).
     * On release the method returns and the caller continues into the unchanged
     * production path, which re-reads the Run inside its own transaction.
     */
    public void passThrough(UUID runId) {
        Barrier barrier = barriers.get(runId);
        if (barrier == null) {
            return;
        }
        barrier.state = State.REACHED;
        barrier.reachedAt = Instant.now();
        logger.info("[E2E] service=cp event=guidance_barrier_reached runId={} e2eRunId={}",
                runId, barrier.e2eRunId);
        try {
            barrier.released.get(barrier.holdMs, TimeUnit.MILLISECONDS);
        } catch (TimeoutException timeout) {
            barriers.remove(runId, barrier);
            logger.warn("[E2E] service=cp event=guidance_barrier_timeout runId={} e2eRunId={}",
                    runId, barrier.e2eRunId);
            throw new CpApiException(HttpStatus.SERVICE_UNAVAILABLE, ERROR_TIMEOUT,
                    "Guidance barrier was not released in time");
        } catch (InterruptedException interrupted) {
            barriers.remove(runId, barrier);
            Thread.currentThread().interrupt();
            throw new CpApiException(HttpStatus.SERVICE_UNAVAILABLE, ERROR_TIMEOUT,
                    "Guidance barrier wait was interrupted");
        } catch (ExecutionException failure) {
            barriers.remove(runId, barrier);
            throw new CpApiException(HttpStatus.SERVICE_UNAVAILABLE, ERROR_TIMEOUT,
                    "Guidance barrier failed");
        }
    }

    /** Test and shutdown hook: drop every barrier without waiting. */
    public void clearAll() {
        barriers.values().forEach(barrier -> barrier.released.complete(null));
        barriers.clear();
    }

    /** Number of currently armed barriers; used by the isolation assertions. */
    public int activeBarriers() {
        return barriers.size();
    }
}
