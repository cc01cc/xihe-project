package com.cc01cc.p.xihe.cp.event;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Component;
import org.springframework.web.context.request.async.AsyncRequestNotUsableException;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import java.io.IOException;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentMap;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;

/**
 * In-memory Workspace event fan-out for the v1 SSE surface.
 *
 * <p>The queue is deliberately zero-depth: events are sent directly to active
 * emitters and a failed/slow connection is removed. A reconnect with a stale
 * Last-Event-ID receives {@code snapshot_required}; v1 does not claim replay.
 */
@Component
public class WorkspaceEventManager {

    private static final long HEARTBEAT_INTERVAL_MS = 15_000L;
    private static final int MAX_SUBSCRIBERS_PER_WORKSPACE = 8;
    private static final Logger logger = LoggerFactory.getLogger(WorkspaceEventManager.class);
    private static final ScheduledExecutorService HEARTBEATS = Executors.newScheduledThreadPool(
            1, new DaemonThreadFactory());

    private final ConcurrentMap<String, WorkspaceChannel> channels = new ConcurrentHashMap<>();

    public SseEmitter subscribe(String workspaceId, long lastEventId) {
        WorkspaceChannel channel = channels.computeIfAbsent(workspaceId, ignored -> new WorkspaceChannel());
        SseEmitter emitter = new SseEmitter(0L);
        Subscriber subscriber;
        synchronized (channel) {
            if (channel.subscribers.size() >= MAX_SUBSCRIBERS_PER_WORKSPACE) {
                throw new CpApiException(
                        HttpStatus.TOO_MANY_REQUESTS,
                        "WORKSPACE_EVENT_SUBSCRIBERS_LIMIT",
                        "Workspace event subscriber limit reached");
            }
            long subscriptionId = channel.subscriptionIds.incrementAndGet();
            subscriber = new Subscriber(workspaceId, subscriptionId, emitter);
            channel.subscribers.put(subscriptionId, subscriber);
        }
        long subscriptionId = subscriber.subscriptionId;
        subscriber.heartbeat = HEARTBEATS.scheduleAtFixedRate(
                () -> sendHeartbeat(channel, subscriber),
                HEARTBEAT_INTERVAL_MS,
                HEARTBEAT_INTERVAL_MS,
                TimeUnit.MILLISECONDS);
        emitter.onCompletion(() -> remove(channel, subscriber, "completion"));
        emitter.onTimeout(() -> remove(channel, subscriber, "timeout"));
        emitter.onError(error -> remove(channel, subscriber, "error"));

        long currentSequence = channel.sequence.get();
        if (lastEventId < currentSequence) {
            WorkspaceEvent snapshotRequired = new WorkspaceEvent(
                    workspaceId,
                    currentSequence,
                    "snapshot_required",
                    null,
                    null,
                    "control-plane",
                    Long.toString(currentSequence),
                    null);
            send(channel, subscriber, snapshotRequired);
            logger.info("[LIFECYCLE] service=cp event=workspace_sse_snapshot_required workspaceId={} "
                            + "lastEventId={} currentSequence={} outcome=ok",
                    workspaceId, lastEventId, currentSequence);
        }

        logger.info("[LIFECYCLE] service=cp event=workspace_sse_registered workspaceId={} "
                        + "subscriptionId={} lastEventId={} currentSequence={} outcome=ok",
                workspaceId, subscriptionId, lastEventId, currentSequence);
        return emitter;
    }

    public WorkspaceEvent publish(
            String workspaceId,
            String kind,
            String path,
            String changeType,
            String source,
            String snapshotVersion,
            String status) {
        validateWorkspaceId(workspaceId);
        validateKind(kind);
        validateSource(source);
        validatePath(path);
        WorkspaceChannel channel = channels.computeIfAbsent(workspaceId, ignored -> new WorkspaceChannel());
        long sequence = channel.sequence.incrementAndGet();
        WorkspaceEvent event = new WorkspaceEvent(
                workspaceId,
                sequence,
                kind,
                path,
                changeType,
                source,
                snapshotVersion,
                status);
        for (Subscriber subscriber : channel.subscribers.values()) {
            send(channel, subscriber, event);
        }
        return event;
    }

    public long currentSequence(String workspaceId) {
        WorkspaceChannel channel = channels.get(workspaceId);
        return channel == null ? 0L : channel.sequence.get();
    }

    /** Closes all listeners when the Workspace lifecycle reaches deletion. */
    public void completeWorkspace(String workspaceId, String reason) {
        WorkspaceChannel channel = channels.remove(workspaceId);
        if (channel == null) return;
        for (Subscriber subscriber : channel.subscribers.values()) {
            if (remove(channel, subscriber, reason)) {
                subscriber.emitter.complete();
            }
        }
    }

    private void sendHeartbeat(WorkspaceChannel channel, Subscriber subscriber) {
        if (!isCurrent(channel, subscriber)) {
            cancelHeartbeat(subscriber);
            return;
        }
        try {
            subscriber.emitter.send(SseEmitter.event()
                    .name("heartbeat")
                    .data(Map.of(
                            "workspaceId", subscriber.workspaceId,
                            "sequence", channel.sequence.get(),
                            "type", "heartbeat")));
        } catch (IOException | IllegalStateException error) {
            logger.info("[LIFECYCLE] service=cp event=workspace_sse_send_failed workspaceId={} "
                            + "subscriptionId={} eventName=heartbeat errorCode=SSE_HEARTBEAT_FAILED",
                    subscriber.workspaceId, subscriber.subscriptionId, error);
            remove(channel, subscriber, "heartbeat_failed");
        }
    }

    private void send(WorkspaceChannel channel, Subscriber subscriber, WorkspaceEvent event) {
        if (!isCurrent(channel, subscriber)) return;
        try {
            subscriber.emitter.send(SseEmitter.event()
                    .id(Long.toString(event.sequence()))
                    .name(event.kind())
                    .data(event));
        } catch (IOException | IllegalStateException error) {
            if (isClientDisconnect(error)) {
                logger.info("[LIFECYCLE] service=cp event=workspace_sse_client_closed workspaceId={} "
                                + "subscriptionId={} sequence={} reason=client_disconnect",
                        subscriber.workspaceId, subscriber.subscriptionId, event.sequence());
            } else {
                logger.warn("[LIFECYCLE] service=cp event=workspace_sse_send_failed workspaceId={} "
                                + "subscriptionId={} sequence={} eventName={} errorCode=SSE_SEND_FAILED",
                        subscriber.workspaceId, subscriber.subscriptionId, event.sequence(), event.kind(), error);
            }
            remove(channel, subscriber, "send_failed");
        }
    }

    private boolean isCurrent(WorkspaceChannel channel, Subscriber subscriber) {
        return !subscriber.closed.get() && channel.subscribers.get(subscriber.subscriptionId) == subscriber;
    }

    private boolean remove(WorkspaceChannel channel, Subscriber subscriber, String reason) {
        if (!subscriber.closed.compareAndSet(false, true)) return false;
        cancelHeartbeat(subscriber);
        boolean removed = channel.subscribers.remove(subscriber.subscriptionId, subscriber);
        if (removed) {
            logger.info("[LIFECYCLE] service=cp event=workspace_sse_closed workspaceId={} "
                            + "subscriptionId={} reason={}",
                    subscriber.workspaceId, subscriber.subscriptionId, reason);
        }
        return removed;
    }

    private void cancelHeartbeat(Subscriber subscriber) {
        ScheduledFuture<?> heartbeat = subscriber.heartbeat;
        if (heartbeat != null) {
            heartbeat.cancel(false);
            subscriber.heartbeat = null;
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

    private void validateWorkspaceId(String workspaceId) {
        if (workspaceId == null || workspaceId.isBlank()) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST", "workspaceId is required");
        }
    }

    private void validateKind(String kind) {
        if (!"workspace_status".equals(kind)
                && !"file_changed".equals(kind)
                && !"snapshot_required".equals(kind)
                && !"workspace_event_error".equals(kind)) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST", "Unsupported Workspace event kind");
        }
    }

    private void validateSource(String source) {
        if (source == null || source.isBlank() || source.length() > 80) {
            throw new CpApiException(HttpStatus.BAD_REQUEST, "INVALID_REQUEST", "source is required");
        }
    }

    private void validatePath(String path) {
        if (path == null) return;
        if (path.isBlank() || path.startsWith("/") || path.contains("\\") || path.matches("^[A-Za-z]:.*")
                || java.util.Arrays.stream(path.split("/", -1)).anyMatch(".."::equals)) {
            throw new CpApiException(
                    HttpStatus.BAD_REQUEST,
                    "INVALID_WORKSPACE_PATH",
                    "path must be a Workspace-relative POSIX path");
        }
    }

    private static final class WorkspaceChannel {
        private final AtomicLong sequence = new AtomicLong();
        private final AtomicLong subscriptionIds = new AtomicLong();
        private final ConcurrentMap<Long, Subscriber> subscribers = new ConcurrentHashMap<>();
    }

    private static final class Subscriber {
        private final String workspaceId;
        private final long subscriptionId;
        private final SseEmitter emitter;
        private final java.util.concurrent.atomic.AtomicBoolean closed =
                new java.util.concurrent.atomic.AtomicBoolean(false);
        private volatile ScheduledFuture<?> heartbeat;

        private Subscriber(String workspaceId, long subscriptionId, SseEmitter emitter) {
            this.workspaceId = workspaceId;
            this.subscriptionId = subscriptionId;
            this.emitter = emitter;
        }
    }

    private static final class DaemonThreadFactory implements ThreadFactory {
        @Override
        public Thread newThread(Runnable runnable) {
            Thread thread = new Thread(runnable, "xihe-workspace-sse-heartbeat");
            thread.setDaemon(true);
            return thread;
        }
    }
}
