package com.cc01cc.p.xihe.cp.channel;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

/**
 * In-memory registry of connected Runtime channel sessions (PLAN-245).
 *
 * <p>One process-level session per deviceId. A repeated deviceId with a live
 * session is rejected (DEVICE_CONFLICT) so a stale connection can never shadow
 * the current one. The registry is CP-local state: a CP restart clears it and
 * Runtimes rebuild it by reconnecting and re-sending hello.</p>
 */
@Component
public class ChannelSessionRegistry {

    private static final Logger logger =
            LoggerFactory.getLogger(ChannelSessionRegistry.class);

    /** Recent messages per session, bounded, for ack correlation. */
    private static final int PENDING_BOUND = 256;

    public record ChannelSession(
            String deviceId,
            String sessionId,
            long connectedAtEpochMs,
            long lastHeartbeatEpochMs,
            long lastSequence) {

        ChannelSession withHeartbeat(long atEpochMs, long sequence) {
            return new ChannelSession(deviceId, sessionId, connectedAtEpochMs, atEpochMs, sequence);
        }
    }

    private final Map<String, ChannelSession> sessionsByDevice = new ConcurrentHashMap<>();

    /**
     * Registers a session. Returns null when the deviceId already has a live
     * session (caller must reject with DEVICE_CONFLICT).
     */
    public synchronized ChannelSession register(String deviceId, String sessionId) {
        ChannelSession existing = sessionsByDevice.get(deviceId);
        if (existing != null) {
            return null;
        }
        long now = System.currentTimeMillis();
        ChannelSession session =
                new ChannelSession(deviceId, sessionId, now, now, 0L);
        sessionsByDevice.put(deviceId, session);
        logger.info(
                "[LIFECYCLE] service=cp event=channel_connected deviceId={} sessionId={}",
                deviceId, sessionId);
        return session;
    }

    public synchronized ChannelSession unregister(String sessionId) {
        for (ChannelSession session : sessionsByDevice.values()) {
            if (session.sessionId().equals(sessionId)) {
                sessionsByDevice.remove(session.deviceId());
                logger.info(
                        "[LIFECYCLE] service=cp event=channel_disconnected deviceId={} sessionId={}",
                        session.deviceId(), sessionId);
                return session;
            }
        }
        return null;
    }

    public synchronized ChannelSession touchHeartbeat(String sessionId, long sequence) {
        for (ChannelSession session : sessionsByDevice.values()) {
            if (session.sessionId().equals(sessionId)) {
                ChannelSession updated =
                        session.withHeartbeat(System.currentTimeMillis(), sequence);
                sessionsByDevice.put(updated.deviceId(), updated);
                return updated;
            }
        }
        return null;
    }

    public ChannelSession byDevice(String deviceId) {
        return sessionsByDevice.get(deviceId);
    }

    public ChannelSession bySession(String sessionId) {
        for (ChannelSession session : sessionsByDevice.values()) {
            if (session.sessionId().equals(sessionId)) {
                return session;
            }
        }
        return null;
    }

    /** Sessions whose last heartbeat is older than the given timeout. */
    public List<ChannelSession> stale(long timeoutMs) {
        long cutoff = System.currentTimeMillis() - timeoutMs;
        List<ChannelSession> result = new ArrayList<>();
        for (ChannelSession session : sessionsByDevice.values()) {
            if (session.lastHeartbeatEpochMs() < cutoff) {
                result.add(session);
            }
        }
        return result;
    }

    public boolean isEmpty() {
        return sessionsByDevice.isEmpty();
    }

    /** Live device ids (snapshot, unordered). */
    public synchronized List<String> deviceIds() {
        return new ArrayList<>(sessionsByDevice.keySet());
    }

    /** Bounded pending-message ids per session (ack correlation helper). */
    public static final class PendingMessages {
        private final Deque<String> ids = new ArrayDeque<>();

        public synchronized void add(String messageId) {
            ids.addLast(messageId);
            while (ids.size() > PENDING_BOUND) {
                ids.removeFirst();
            }
        }

        public synchronized boolean remove(String messageId) {
            return ids.remove(messageId);
        }

        public static String newMessageId() {
            return UUID.randomUUID().toString();
        }
    }
}
