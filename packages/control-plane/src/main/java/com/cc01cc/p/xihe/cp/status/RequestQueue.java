package com.cc01cc.p.xihe.cp.status;

import com.cc01cc.p.xihe.cp.files.dto.AttachmentInfo;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.function.Consumer;

@Component
public class RequestQueue {

    private static final Logger logger = LoggerFactory.getLogger(RequestQueue.class);
    private static final int MAX_SIZE = 100;
    private static final long TTL_SECONDS = 60;

    private final ConcurrentLinkedQueue<QueuedRequest> queue = new ConcurrentLinkedQueue<>();

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
                Instant.now(), requestId, runId,
                toolTimeouts == null ? Map.of() : Map.copyOf(toolTimeouts)));
        logger.info("[LIFECYCLE] service=cp event=requestQueued sessionId={} reason=agent_down queueSize={}", sessionId, queue.size());
        return true;
    }

    /**
     * task-132: the consumer reports whether it actually handed the request to the transport.
     *
     * <p>Without this, "no exception" was indistinguishable from "delivered": a consumer that
     * refused a request (e.g. the drain guard deciding the run is already active) still counted as
     * a delivery, so {@code requestDrained count=N} said N things were sent while N were dropped.</p>
     */
    @FunctionalInterface
    public interface Deliverer {

        /**
         * @return {@code true} only when the request really went out; {@code false} means the
         *         consumer refused it (it owns the resulting terminal state, so {@code onDropped}
         *         is not called again).
         */
        boolean deliver(QueuedRequest request);
    }

    public int drain(Deliverer sender) {
        return drain(sender, ignored -> {});
    }

    public int drain(Deliverer sender, Consumer<QueuedRequest> onDropped) {
        int sent = 0;
        int dropped = 0;
        int expired = 0;
        while (!queue.isEmpty()) {
            QueuedRequest req = queue.poll();
            if (req == null) {
                break;
            }

            if (Instant.now().getEpochSecond() - req.createdAt().getEpochSecond() > TTL_SECONDS) {
                expired++;
                dropped++;
                logger.info("[LIFECYCLE] service=cp event=requestQueueExpired sessionId={} ttlSeconds={}", req.sessionId(), TTL_SECONDS);
                notifyDropped(onDropped, req);
                continue;
            }

            try {
                if (sender.deliver(req)) {
                    sent++;
                } else {
                    dropped++;
                }
            } catch (Exception e) {
                dropped++;
                logger.warn("[LIFECYCLE] service=cp event=requestDrainFailed sessionId={} error={}", req.sessionId(), e.getMessage());
                notifyDropped(onDropped, req);
            }
        }
        if (sent > 0 || dropped > 0) {
            logger.info("[LIFECYCLE] service=cp event=requestDrained count={} dropped={} expiredCount={}",
                    sent, dropped, expired);
        }
        return sent;
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
