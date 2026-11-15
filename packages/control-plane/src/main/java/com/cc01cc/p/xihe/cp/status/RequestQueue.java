package com.cc01cc.p.xihe.cp.status;

import com.cc01cc.p.xihe.cp.files.dto.AttachmentInfo;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import java.time.Clock;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.function.Consumer;

@Component
public class RequestQueue {

    private static final Logger logger = LoggerFactory.getLogger(RequestQueue.class);
    private static final int MAX_SIZE = 100;
    /**
     * task-134 A2: parked requests live this long. Reconciliation reads the same constant, because
     * TTL expiry has exactly one owner — the periodic reconciler — so the two sides cannot drift.
     *
     * <p>Shared contract: {@code ChatRunReconciliationService} derives its takeover window from this
     * constant. Changing one side without the other makes the two disagree about when a parked run
     * is still deliverable.</p>
     */
    public static final long TTL_SECONDS = 60;

    private final ConcurrentLinkedQueue<QueuedRequest> queue = new ConcurrentLinkedQueue<>();
    /** task-136: the TTL is 60 s of wall clock, so expiry can only be tested with an injected clock. */
    private final Clock clock;

    public RequestQueue() {
        this(Clock.systemUTC());
    }

    /**
     * Test seam only: production code uses {@link #RequestQueue()} with system UTC. A collision test
     * has to age an entry past the 60 s TTL without sleeping, and duplicating the TTL rule inside a
     * test would re-implement the very semantics under test.
     */
    public RequestQueue(Clock clock) {
        this.clock = clock;
    }

    public boolean enqueue(String sessionId, String content, String model, String userId, String workspaceId) {
        return enqueue(sessionId, content, null, model, "none", List.of(), userId, workspaceId, null, null);
    }

    public boolean enqueue(String sessionId, String content, String model, String userId,
                           String workspaceId, String requestId, String runId) {
        return enqueue(sessionId, content, null, model, "none", List.of(), userId, workspaceId, requestId, runId);
    }

    public boolean enqueue(String sessionId, String content, String provider, String model,
                           String toolMode, List<AttachmentInfo> attachments, String userId,
                           String workspaceId, String requestId, String runId) {
        return enqueue(sessionId, content, provider, model, toolMode, attachments, userId,
                workspaceId, requestId, runId, Map.of());
    }

    /** PLAN-0308 T1.9：per-call 超时（已校验）随排队请求保留，投递时不丢。 */
    public boolean enqueue(String sessionId, String content, String provider, String model,
                           String toolMode, List<AttachmentInfo> attachments, String userId,
                           String workspaceId, String requestId, String runId,
                           Map<String, Integer> toolTimeouts) {
        if (queue.size() >= MAX_SIZE) {
            logger.warn("[LIFECYCLE] service=cp event=requestQueueFull sessionId={} queueSize={}", sessionId, queue.size());
            return false;
        }
        queue.offer(new QueuedRequest(sessionId, content, provider, model, toolMode,
                attachments == null ? List.of() : List.copyOf(attachments), userId, workspaceId,
                Instant.now(clock), requestId, runId,
                toolTimeouts == null ? Map.of() : Map.copyOf(toolTimeouts)));
        logger.info("[LIFECYCLE] service=cp event=requestQueued sessionId={} reason=agent_down queueSize={}", sessionId, queue.size());
        return true;
    }

    /**
     * task-132: the consumer reports whether it actually handed the request to the transport.
     *
     * <p>Without this, "no exception" was indistinguishable from "delivered": a consumer that
     * refused a request (e.g. the drain guard deciding the run is already active) still counted as
     * a delivery, so the drain line said N things were sent while N were dropped (the field is
     * {@code delivered} since task-136 split the counters).</p>
     */
    @FunctionalInterface
    public interface Deliverer {

        /**
         * task-136: {@code true} means the request was <b>handed to</b> {@code execAsync}
         * (fire-and-forget) — it does <b>not</b> mean end-to-end delivery. The transport, the agent
         * and the run's terminal state are all downstream of this call: a real failure is expressed
         * by {@code chat_runs.status}/{@code error_code} plus {@code chat_run_history}, never by this
         * return value. Do not read {@code delivered} in the drain line as "answered".
         *
         * @return {@code false} when the consumer refused the request (it owns the resulting
         *         terminal state, so {@code onDropped} is not called again)
         */
        boolean deliver(QueuedRequest request);
    }

    public int drain(Deliverer sender) {
        return drain(sender, ignored -> {});
    }

    public int drain(Deliverer sender, Consumer<QueuedRequest> onDropped) {
        // task-136: three mutually exclusive outcomes, so the three log fields can be read side by
        // side (they sum to the number of entries the scan touched). Before this, "dropped"
        // included expiries while "expiredCount" was printed next to it as if they were siblings.
        int delivered = 0;
        int dropped = 0;
        int expired = 0;
        while (!queue.isEmpty()) {
            QueuedRequest req = queue.poll();
            if (req == null) {
                break;
            }

            if (Instant.now(clock).getEpochSecond() - req.createdAt().getEpochSecond() > TTL_SECONDS) {
                // task-134 A2 (constraint 1): TTL expiry has ONE owner — the periodic reconciler,
                // which is the only observer that is guaranteed to run (the drain only fires on a
                // down→up edge and does not run at all for a wedged request). Emitting a terminal
                // here would race the reconciler for the same run and make the user-visible code
                // depend on timing, so the drain only counts it and points at the run.
                expired++;
                logger.info("[LIFECYCLE] service=cp event=requestQueueExpired sessionId={} runId={} requestId={} ttlSeconds={} owner=reconciliation",
                        req.sessionId(), req.runId(), req.requestId(), TTL_SECONDS);
                continue;
            }

            try {
                if (sender.deliver(req)) {
                    delivered++;
                } else {
                    dropped++;
                }
            } catch (Exception e) {
                dropped++;
                logger.warn("[LIFECYCLE] service=cp event=requestDrainFailed sessionId={} error={}", req.sessionId(), e.getMessage());
                notifyDropped(onDropped, req);
            }
        }
        if (delivered > 0 || dropped > 0 || expired > 0) {
            logger.info("[LIFECYCLE] service=cp event=requestDrained delivered={} dropped={} expired={}",
                    delivered, dropped, expired);
        }
        return delivered;
    }

    private void notifyDropped(Consumer<QueuedRequest> onDropped, QueuedRequest request) {
        try {
            onDropped.accept(request);
        } catch (Exception e) {
            logger.error("[LIFECYCLE] service=cp event=requestDropHandlerFailed sessionId={} runId={}",
                    request.sessionId(), request.runId(), e);
        }
    }

    public int size() {
        return queue.size();
    }

    public void clear() {
        queue.clear();
    }

    public record QueuedRequest(
        String sessionId,
        String content,
        String provider,
        String model,
        String toolMode,
        List<AttachmentInfo> attachments,
        String userId,
        String workspaceId,
        Instant createdAt,
        String requestId,
        String runId,
        Map<String, Integer> toolTimeouts
    ) {}
}
