package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.config.TenantContext;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Component;
import org.springframework.web.context.request.async.AsyncRequestNotUsableException;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;

import com.cc01cc.p.xihe.cp.context.service.CompactionNoticePort;

/**
 * SseEmitterManager manages the SSE connections of a UI session.
 *
 * <p>BL-306: a session is no longer one connection. Multiple viewers (owner tabs, declared
 * participant views) must coexist, so the registry is keyed by
 * {@code sessionId -> connectionKey}, where
 * {@code connectionKey = viewerKey + "\0" + connectionInstance}:
 *
 * <ul>
 *   <li>{@code viewerKey} is derived from the authenticated caller ({@code owner:<userId>} or
 *       {@code participant:<callerUserId>:<asParticipantId>}) — never from a client-supplied
 *       participant id alone;</li>
 *   <li>{@code connectionInstance} comes from the client header {@code X-XH-SSE-Connection-Id}
 *       (per browser tab, in-memory); a missing value gets a server-generated UUID. Reconnecting
 *       with the same instance replaces only that entry.</li>
 * </ul>
 *
 * <p>{@code sse.multiConnection.enabled=false} switches back to the legacy single-entry behaviour
 * (server-side rollback; changing only the UI does not roll back).
 *
 * <p>PLAN-0470 #24/D1b: also implements {@link CompactionNoticePort} so the
 * Context domain can surface compaction-circuit notices without depending on
 * this concrete class; wire format is unchanged.
 */
@Component
public class SseEmitterManager implements CompactionNoticePort {

    private static final long HEARTBEAT_INTERVAL_MS = 15_000L;
    private static final Logger logger = LoggerFactory.getLogger(SseEmitterManager.class);
    private static final ScheduledExecutorService HEARTBEATS = Executors.newScheduledThreadPool(
            1, new DaemonThreadFactory());
    private static final int MAX_CONNECTION_INSTANCE_LENGTH = 64;

    private final Map<String, Map<String, EmitterEntry>> emitters = new ConcurrentHashMap<>();
    private final Map<String, AtomicLong> generations = new ConcurrentHashMap<>();

    @Value("${sse.multiConnection.enabled:true}")
    private boolean multiConnectionEnabled = true;

    @Value("${sse.multiConnection.maxPerSession:8}")
    private int maxConnectionsPerSession = 8;

    public SseEmitter createEmitter(String sessionId) {
        return createEmitter(sessionId, null, null);
    }

    /**
     * PLAN-0623 M1b-③: {@code asParticipantId} declares the subscriber's <b>participant view</b>
     * (D23-28 observer semantics). Declared ⇒ only events produced by that participant plus
     * producer-less system events; undeclared ⇒ the full stream. Filtering is by <b>producer</b>,
     * never by visibility — system events are broadcast to every view.
     */
    public SseEmitter createEmitter(String sessionId, String asParticipantId) {
        return createEmitter(sessionId, asParticipantId, null);
    }

    /**
     * BL-306: {@code connectionId} is the client's per-tab connection instance (header
     * {@code X-XH-SSE-Connection-Id}). Same instance ⇒ replace that entry; different instance ⇒
     * coexist (up to the per-session limit, 409 {@code SSE_CONNECTION_LIMIT} when exceeded).
     */
    public SseEmitter createEmitter(String sessionId, String asParticipantId, String connectionId) {
        String viewerKey = viewerKey(asParticipantId);
        String instance = normalizeInstance(connectionId);
        String connectionKey = connectionKey(viewerKey, instance);

        long generation = generations
                .computeIfAbsent(sessionId, ignored -> new AtomicLong())
                .incrementAndGet();
        SseEmitter emitter = new SseEmitter(0L);
        EmitterEntry entry = new EmitterEntry(sessionId, viewerKey, instance, connectionKey,
                generation, emitter, asParticipantId);

        emitter.onCompletion(() -> removeIfCurrent(entry, "completion"));
        emitter.onTimeout(() -> removeIfCurrent(entry, "timeout"));
        emitter.onError(e -> removeIfCurrent(entry, "error"));

        Map<String, EmitterEntry> sessionEmitters =
                emitters.computeIfAbsent(sessionId, ignored -> new ConcurrentHashMap<>());
        EmitterEntry previous;
        synchronized (sessionEmitters) {
            previous = sessionEmitters.get(connectionKey);
            if (previous == null && multiConnectionEnabled && liveCount(sessionEmitters) >= maxConnectionsPerSession) {
                throw new CpApiException(HttpStatus.CONFLICT, "SSE_CONNECTION_LIMIT",
                        "session has reached the SSE connection limit of " + maxConnectionsPerSession
                                + "; close an unused tab or reconnect with the same connection id");
            }
            sessionEmitters.put(connectionKey, entry);
        }
        if (previous != null) {
            closeReplaced(previous, entry);
        }

        entry.heartbeat = HEARTBEATS.scheduleAtFixedRate(
                () -> sendHeartbeat(entry),
                HEARTBEAT_INTERVAL_MS,
                HEARTBEAT_INTERVAL_MS,
                java.util.concurrent.TimeUnit.MILLISECONDS);
        logger.info("[LIFECYCLE] service=cp event=chat_sse_registered sessionId={} viewerKey={} "
                        + "connectionInstance={} connectionGeneration={} outcome=ok",
                sessionId, viewerKey, instance, generation);
        return emitter;
    }

    /** Legacy shape: an event with no participant attribution (system event). */
    public boolean send(String sessionId, String eventName, Object data) {
        return send(sessionId, eventName, data, null);
    }

    /**
     * PLAN-0623 M1b-③: every event carries {@code participantId} — the participant row that
     * produced this output, or {@code null} for producer-less system events (never invented).
     * The payload is enriched with the field so undeclared (observer) consumers can still tell
     * multi-subject streams apart. Delivery to a declared view is skipped (not an error) when
     * the producer is another participant.
     *
     * <p>BL-306: the event is fanned out to every live connection of the session; a failed
     * connection only removes its own entry and never aborts the rest of the broadcast.
     */
    public boolean send(String sessionId, String eventName, Object data, String participantId) {
        List<EmitterEntry> entries = snapshot(sessionId);
        if (entries.isEmpty()) {
            logger.debug("[LIFECYCLE] service=cp event=chat_sse_unavailable sessionId={} eventName={} errorCode=SSE_SUBSCRIPTION_REQUIRED",
                    sessionId, eventName);
            return false;
        }
        boolean anyAccepted = false;
        for (EmitterEntry entry : entries) {
            if (entry.closed.get()) {
                continue;
            }
            if (!entry.accepts(participantId)) {
                logger.debug("[LIFECYCLE] service=cp event=chat_sse_event_filtered sessionId={} connectionGeneration={} eventName={} view={} producer={}",
                        sessionId, entry.generation, eventName, entry.asParticipantId, participantId);
                anyAccepted = true;
                continue;
            }
            try {
                entry.emitter.send(SseEmitter.event()
                    .name(eventName)
                    .data(enrichWithParticipantId(data, participantId)));
                anyAccepted = true;
                logger.debug("[LIFECYCLE] service=cp event=chat_sse_event_sent sessionId={} connectionGeneration={} eventName={}",
                        sessionId, entry.generation, eventName);
            } catch (IOException | IllegalStateException e) {
                // One broken connection must not take the whole broadcast down.
                if (isClientDisconnect(e)) {
                    logger.info("[LIFECYCLE] service=cp event=chat_sse_client_closed sessionId={} connectionGeneration={} reason=client_disconnect",
                            sessionId, entry.generation);
                    removeIfCurrent(entry, "client_closed");
                } else {
                    logger.warn("[LIFECYCLE] service=cp event=chat_sse_send_failed sessionId={} connectionGeneration={} eventName={} errorCode=SSE_SEND_FAILED",
                            sessionId, entry.generation, eventName, e);
                    removeIfCurrent(entry, "send_failed");
                }
            }
        }
        return anyAccepted;
    }

    /**
     * PLAN-0470 #24/D1b: preserves the exact wire contract used by
     * {@code ContextService} — event {@code context_compaction_circuit} with a
     * {@code type/state/reason} payload. Failures are logged here and never
     * thrown, matching the previous inline try/catch at the call sites.
     */
    @Override
    public void sendCompactionNotice(String sessionId, String state, String reason) {
        try {
            send(sessionId, "context_compaction_circuit", Map.of(
                    "type", "context_compaction_circuit",
                    "state", state,
                    "reason", reason));
        } catch (Exception e) {
            logger.debug("Failed to emit compaction circuit SSE: {}", e.getMessage());
        }
    }

    /** Closes every connection of the session (session deletion / hard cleanup). */
    public void complete(String sessionId) {
        for (EmitterEntry entry : snapshot(sessionId)) {
            if (removeIfCurrent(entry, "completed")) {
                entry.emitter.complete();
            }
        }
    }

    /**
     * Adds {@code participantId} to map/JSON-object payloads (null = producer-less system event,
     * an explicit field so observers never guess). Non-structured payloads are left untouched —
     * every current emit site sends a Map or a JSON object.
     */
    private static Object enrichWithParticipantId(Object data, String participantId) {
        if (data instanceof Map<?, ?> map) {
            java.util.LinkedHashMap<Object, Object> copy = new java.util.LinkedHashMap<>(map);
            copy.put("participantId", participantId);
            return copy;
        }
        if (data instanceof com.fasterxml.jackson.databind.JsonNode node && node.isObject()) {
            if (participantId == null) {
                return ((com.fasterxml.jackson.databind.node.ObjectNode) node).putNull("participantId");
            }
            return ((com.fasterxml.jackson.databind.node.ObjectNode) node).put("participantId", participantId);
        }
        return data;
    }

    /** Closes one specific connection (by emitter identity), leaving the others untouched. */
    public boolean complete(String sessionId, SseEmitter expectedEmitter) {
        EmitterEntry entry = entryFor(sessionId, expectedEmitter);
        if (entry == null) {
            return false;
        }
        if (!removeIfCurrent(entry, "completed")) {
            return false;
        }
        entry.emitter.complete();
        return true;
    }

    /** BL-306: any live entry counts — /chat only needs "at least one subscriber". */
    public boolean hasEmitter(String sessionId) {
        return snapshot(sessionId).stream().anyMatch(entry -> !entry.closed.get());
    }

    /** Test/observability hook: number of live connections registered for a session. */
    public int activeConnectionCount(String sessionId) {
        return (int) snapshot(sessionId).stream().filter(entry -> !entry.closed.get()).count();
    }

    long connectionGeneration(String sessionId) {
        AtomicLong generation = generations.get(sessionId);
        return generation == null ? 0L : generation.get();
    }

    private List<EmitterEntry> snapshot(String sessionId) {
        Map<String, EmitterEntry> sessionEmitters = emitters.get(sessionId);
        return sessionEmitters == null ? List.of() : new ArrayList<>(sessionEmitters.values());
    }

    private EmitterEntry entryFor(String sessionId, SseEmitter expectedEmitter) {
        for (EmitterEntry entry : snapshot(sessionId)) {
            if (entry.emitter == expectedEmitter) {
                return entry;
            }
        }
        return null;
    }

    private static long liveCount(Map<String, EmitterEntry> sessionEmitters) {
        return sessionEmitters.values().stream().filter(entry -> !entry.closed.get()).count();
    }

    private String viewerKey(String asParticipantId) {
        String callerId = TenantContext.getUserId();
        String caller = callerId == null || callerId.isBlank() ? "anonymous" : callerId;
        if (asParticipantId == null || asParticipantId.isBlank()) {
            return "owner:" + caller;
        }
        return "participant:" + caller + ":" + asParticipantId;
    }

    private String connectionKey(String viewerKey, String instance) {
        return multiConnectionEnabled ? viewerKey + "\u0000" + instance : "legacy";
    }

    private static String normalizeInstance(String connectionId) {
        if (connectionId == null || connectionId.isBlank()) {
            return UUID.randomUUID().toString();
        }
        String trimmed = connectionId.trim();
        if (trimmed.length() > MAX_CONNECTION_INSTANCE_LENGTH
                || !trimmed.matches("[A-Za-z0-9._-]+")) {
            return UUID.randomUUID().toString();
        }
        return trimmed;
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
        Map<String, EmitterEntry> sessionEmitters = emitters.get(entry.sessionId);
        boolean removed = false;
        if (sessionEmitters != null) {
            synchronized (sessionEmitters) {
                removed = sessionEmitters.remove(entry.connectionKey, entry);
                if (sessionEmitters.isEmpty()) {
                    emitters.remove(entry.sessionId, sessionEmitters);
                }
            }
        }
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
        Map<String, EmitterEntry> sessionEmitters = emitters.get(entry.sessionId);
        EmitterEntry current = sessionEmitters == null ? null : sessionEmitters.get(entry.connectionKey);
        if (entry.closed.get() || current != entry) {
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
        private final String viewerKey;
        private final String connectionInstance;
        private final String connectionKey;
        private final long generation;
        private final SseEmitter emitter;
        private final String asParticipantId;
        private final AtomicBoolean closed = new AtomicBoolean(false);
        private volatile ScheduledFuture<?> heartbeat;

        private EmitterEntry(String sessionId, String viewerKey, String connectionInstance,
                             String connectionKey, long generation, SseEmitter emitter,
                             String asParticipantId) {
            this.sessionId = sessionId;
            this.viewerKey = viewerKey;
            this.connectionInstance = connectionInstance;
            this.connectionKey = connectionKey;
            this.generation = generation;
            this.emitter = emitter;
            this.asParticipantId = asParticipantId;
        }

        /** Declared views receive their own producer plus producer-less system events. */
        private boolean accepts(String participantId) {
            return asParticipantId == null || participantId == null || asParticipantId.equals(participantId);
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
