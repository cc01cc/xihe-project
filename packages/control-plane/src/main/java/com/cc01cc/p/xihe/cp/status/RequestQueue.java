package com.cc01cc.p.xihe.cp.status;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import java.time.Instant;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.function.Consumer;

@Component
public class RequestQueue {

    private static final Logger logger = LoggerFactory.getLogger(RequestQueue.class);
    private static final int MAX_SIZE = 100;
    private static final long TTL_SECONDS = 60;

    private final ConcurrentLinkedQueue<QueuedRequest> queue = new ConcurrentLinkedQueue<>();

    public boolean enqueue(String sessionId, String content, String model, String userId, String workspaceId) {
        return enqueue(sessionId, content, model, userId, workspaceId, null, null);
    }

    public boolean enqueue(String sessionId, String content, String model, String userId,
                           String workspaceId, String requestId, String runId) {
        if (queue.size() >= MAX_SIZE) {
            logger.warn("[LIFECYCLE] service=cp event=requestQueueFull sessionId={} queueSize={}", sessionId, queue.size());
            return false;
        }
        queue.offer(new QueuedRequest(sessionId, content, model, userId, workspaceId,
                Instant.now(), requestId, runId));
        logger.info("[LIFECYCLE] service=cp event=requestQueued sessionId={} reason=agent_down queueSize={}", sessionId, queue.size());
        return true;
    }

    public int drain(Consumer<QueuedRequest> sender) {
        int sent = 0;
        int expired = 0;
        while (!queue.isEmpty()) {
            QueuedRequest req = queue.poll();
            if (req == null) break;

            if (Instant.now().getEpochSecond() - req.createdAt().getEpochSecond() > TTL_SECONDS) {
                expired++;
                logger.info("[LIFECYCLE] service=cp event=requestQueueExpired sessionId={} ttlSeconds={}", req.sessionId(), TTL_SECONDS);
                continue;
            }

            try {
                sender.accept(req);
                sent++;
            } catch (Exception e) {
                logger.warn("[LIFECYCLE] service=cp event=requestDrainFailed sessionId={} error={}", req.sessionId(), e.getMessage());
            }
        }
        if (sent > 0 || expired > 0) {
            logger.info("[LIFECYCLE] service=cp event=requestDrained count={} expiredCount={}", sent, expired);
        }
        return sent;
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
        String model,
        String userId,
        String workspaceId,
        Instant createdAt,
        String requestId,
        String runId
    ) {}
}
