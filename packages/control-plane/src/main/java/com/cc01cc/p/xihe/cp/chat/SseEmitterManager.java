package com.cc01cc.p.xihe.cp.chat;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;
import org.springframework.web.context.request.async.AsyncRequestNotUsableException;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import java.io.IOException;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;

/**
 * SseEmitterManager manages one reusable SSE connection per UI session.
 * A connection generation protects a newer emitter from stale callbacks
 * belonging to a replaced connection.
 */
@Component
public class SseEmitterManager {

    private static final long HEARTBEAT_INTERVAL_MS = 15_000L;
    private static final Logger logger = LoggerFactory.getLogger(SseEmitterManager.class);
    private static final ScheduledExecutorService HEARTBEATS = Executors.newScheduledThreadPool(
            1, new DaemonThreadFactory());

    private final Map<String, EmitterEntry> emitters = new ConcurrentHashMap<>();
    private final Map<String, AtomicLong> generations = new ConcurrentHashMap<>();

    public SseEmitter createEmitter(String sessionId) {
        SseEmitter emitter = new SseEmitter(0L);
        long generation = generations
                .computeIfAbsent(sessionId, ignored -> new AtomicLong())
                .incrementAndGet();
        EmitterEntry entry = new EmitterEntry(sessionId, generation, emitter);

        emitter.onCompletion(() -> removeIfCurrent(entry, "completion"));
        emitter.onTimeout(() -> removeIfCurrent(entry, "timeout"));
        emitter.onError(e -> removeIfCurrent(entry, "error"));

        EmitterEntry previous = emitters.put(sessionId, entry);
        if (previous != null) {
            closeReplaced(previous, entry);
        }

        entry.heartbeat = HEARTBEATS.scheduleAtFixedRate(
                () -> sendHeartbeat(entry),
                HEARTBEAT_INTERVAL_MS,
                HEARTBEAT_INTERVAL_MS,
                java.util.concurrent.TimeUnit.MILLISECONDS);
        logger.info("[LIFECYCLE] service=cp event=chat_sse_registered sessionId={} connectionGeneration={} outcome=ok",
                sessionId, generation);
        return emitter;
    }

    public boolean send(String sessionId, String eventName, Object data) {
        EmitterEntry entry = emitters.get(sessionId);
        if (entry != null && !entry.closed.get()) {
            try {
                entry.emitter.send(SseEmitter.event()
                    .name(eventName)
                    .data(data));
                logger.debug("[LIFECYCLE] service=cp event=chat_sse_event_sent sessionId={} connectionGeneration={} eventName={}",
                        sessionId, entry.generation, eventName);
                return true;
            } catch (IOException | IllegalStateException e) {
                if (isClientDisconnect(e)) {
                    logger.info("[LIFECYCLE] service=cp event=chat_sse_client_closed sessionId={} connectionGeneration={} reason=client_disconnect",
                            sessionId, entry.generation);
                    removeIfCurrent(entry, "client_closed");
                    return false;
                }
                logger.warn("[LIFECYCLE] service=cp event=chat_sse_send_failed sessionId={} connectionGeneration={} eventName={} errorCode=SSE_SEND_FAILED",
                        sessionId, entry.generation, eventName, e);
                removeIfCurrent(entry, "send_failed");
                return false;
            }
        } else {
            logger.debug("[LIFECYCLE] service=cp event=chat_sse_unavailable sessionId={} eventName={} errorCode=SSE_SUBSCRIPTION_REQUIRED",
                    sessionId, eventName);
            return false;
        }
    }

    public void complete(String sessionId) {
        EmitterEntry entry = emitters.get(sessionId);
        if (entry != null && removeIfCurrent(entry, "completed")) {
            entry.emitter.complete();
        }
    }

    public boolean complete(String sessionId, SseEmitter expectedEmitter) {
        EmitterEntry entry = emitters.get(sessionId);
        if (entry == null || entry.emitter != expectedEmitter) {
            return false;
        }
        if (!removeIfCurrent(entry, "completed")) {
            return false;
        }
        entry.emitter.complete();
        return true;
    }

    public boolean hasEmitter(String sessionId) {
        EmitterEntry entry = emitters.get(sessionId);
        return entry != null && !entry.closed.get();
    }

    long connectionGeneration(String sessionId) {
        EmitterEntry entry = emitters.get(sessionId);
        return entry == null ? 0L : entry.generation;
    }

    private void closeReplaced(EmitterEntry previous, EmitterEntry replacement) {
        logger.info("[LIFECYCLE] service=cp event=chat_sse_replaced sessionId={} oldConnectionGeneration={} newConnectionGeneration={} reason=new_connection",
                previous.sessionId, previous.generation, replacement.generation);
        previous.emitter.complete();
        previous.closed.set(true);
        cancelHeartbeat(previous);
    }

    private boolean removeIfCurrent(EmitterEntry entry, String reason) {
        if (!entry.closed.compareAndSet(false, true)) {
            return false;
        }
        cancelHeartbeat(entry);
        boolean removed = emitters.remove(entry.sessionId, entry);
        if (removed) {
            logger.info("[LIFECYCLE] service=cp event={} sessionId={} connectionGeneration={} reason={}",
                    closeEventName(reason), entry.sessionId, entry.generation, reason);
        } else {
            logger.info("[LIFECYCLE] service=cp event=chat_sse_stale_cleanup_ignored sessionId={} connectionGeneration={} reason={}",
                    entry.sessionId, entry.generation, reason);
        }
        return removed;
    }

    private String closeEventName(String reason) {
        return switch (reason) {
            case "completion" -> "chat_sse_client_closed";
            case "timeout" -> "chat_sse_timeout";
            case "error" -> "chat_sse_error";
            case "send_failed", "heartbeat_failed" -> "chat_sse_send_failed";
            default -> "chat_sse_completed";
        };
    }

    private void sendHeartbeat(EmitterEntry entry) {
        if (entry.closed.get() || emitters.get(entry.sessionId) != entry) {
            cancelHeartbeat(entry);
            return;
        }
        try {
            entry.emitter.send(SseEmitter.event()
                    .name("heartbeat")
                    .data(Map.of("type", "heartbeat", "connectionGeneration", entry.generation)));
        } catch (IOException | IllegalStateException e) {
            if (isClientDisconnect(e)) {
                logger.info("[LIFECYCLE] service=cp event=chat_sse_client_closed sessionId={} connectionGeneration={} reason=client_disconnect",
                        entry.sessionId, entry.generation);
                removeIfCurrent(entry, "client_closed");
                return;
            }
            logger.warn("[LIFECYCLE] service=cp event=chat_sse_send_failed sessionId={} connectionGeneration={} eventName=heartbeat errorCode=SSE_HEARTBEAT_FAILED",
                    entry.sessionId, entry.generation, e);
            removeIfCurrent(entry, "heartbeat_failed");
        }
    }

    private void cancelHeartbeat(EmitterEntry entry) {
        ScheduledFuture<?> heartbeat = entry.heartbeat;
        if (heartbeat != null) {
            heartbeat.cancel(false);
            entry.heartbeat = null;
        }
    }

    private boolean isClientDisconnect(Throwable error) {
        Throwable current = error;
        while (current != null) {
            if (current instanceof AsyncRequestNotUsableException
                    || current.getClass().getName().equals("org.apache.catalina.connector.ClientAbortException")) {
                return true;
            }
            current = current.getCause();
        }
        return false;
    }

    private static final class EmitterEntry {
        private final String sessionId;
        private final long generation;
        private final SseEmitter emitter;
        private final AtomicBoolean closed = new AtomicBoolean(false);
        private volatile ScheduledFuture<?> heartbeat;

        private EmitterEntry(String sessionId, long generation, SseEmitter emitter) {
            this.sessionId = sessionId;
            this.generation = generation;
            this.emitter = emitter;
        }
    }

    private static final class DaemonThreadFactory implements ThreadFactory {
        @Override
        public Thread newThread(Runnable runnable) {
            Thread thread = new Thread(runnable, "xihe-chat-sse-heartbeat");
            thread.setDaemon(true);
            return thread;
        }
    }
}
