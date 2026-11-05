package com.cc01cc.p.xihe.cp.event;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import jakarta.annotation.PreDestroy;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.ConnectionCallback;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import java.io.IOException;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * PLAN-0660 T5.4 — the **user-level** SSE channel behind {@code GET /api/v1/user-events}.
 *
 * <p>Frozen contract ({@code spec/session/user-channel.md} §4):</p>
 * <ul>
 *   <li>keyed by <b>userId</b> (not session, not workspace) — the channel survives workspace switching;</li>
 *   <li>event names are a closed set of <b>public wire</b> names: {@code connected},
 *       {@code participant_notified}, {@code user_question} — deliberately <b>not</b> the internal
 *       {@code wake_*} names (renaming an internal event must never break the UI);</li>
 *   <li><b>multiple tabs are all kept</b> (no single-connection replacement, unlike Chat SSE);</li>
 *   <li>cap <b>8</b> subscribers per user — the 9th is refused explicitly, never silently dropped;</li>
 *   <li>heartbeat every 15s; no replay, no ordering promise, no DB atomicity.</li>
 * </ul>
 *
 * <p>Hints only: {@link UserChannelPort} implementations must not carry counts or body text.</p>
 */
@Component
public class UserChannelSseManager implements UserChannelPort {

    private static final Logger logger = LoggerFactory.getLogger(UserChannelSseManager.class);

    /** Frozen cap (same rule as Workspace/Chat channels): a 9th tab is an explicit refusal. */
    static final int MAX_SUBSCRIBERS_PER_USER = 8;
    static final long HEARTBEAT_SECONDS = 15L;

    static final String EVENT_CONNECTED = "connected";
    static final String EVENT_PARTICIPANT_NOTIFIED = "participant_notified";
    static final String EVENT_USER_QUESTION = "user_question";

    private final Map<String, Set<Subscriber>> subscribers = new ConcurrentHashMap<>();
    private final JdbcTemplate jdbc;
    private final ScheduledExecutorService heartbeat;

    public UserChannelSseManager(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
        heartbeat = Executors.newSingleThreadScheduledExecutor(runnable -> {
            Thread thread = new Thread(runnable, "user-channel-heartbeat");
            thread.setDaemon(true);
            return thread;
        });
        heartbeat.scheduleAtFixedRate(this::sendHeartbeats, HEARTBEAT_SECONDS, HEARTBEAT_SECONDS,
                TimeUnit.SECONDS);
    }

    @PreDestroy
    void stopHeartbeat() {
        heartbeat.shutdown();
    }

    private record UserState(int tokenVersion, int sessionVersion, boolean usable) { }

    /** One live connection of one user (a tab), bound to the versions at registration. */
    static final class Subscriber {
        private final UUID userId;
        private final int tokenVersion;
        private final int sessionVersion;
        private final SseEmitter emitter;
        private final AtomicBoolean closed = new AtomicBoolean(false);

        Subscriber(UUID userId, int tokenVersion, int sessionVersion, SseEmitter emitter) {
            this.userId = userId;
            this.tokenVersion = tokenVersion;
            this.sessionVersion = sessionVersion;
            this.emitter = emitter;
        }

        boolean closeOnce() {
            return closed.compareAndSet(false, true);
        }
    }

    /**
     * Open one channel for a user and hand the emitter back to the controller.
     *
     * <p>Refuses the 9th concurrent subscriber with {@code 429 USER_CHANNEL_FULL}: the UI must know
     * the difference between "too many tabs" and a broken connection.</p>
     */
    public SseEmitter register(String userId, int tokenVersion) {
        return subscribe(userId, tokenVersion, new SseEmitter(0L));
    }

    /** Test seam: same authentication state and cap, but the caller supplies the emitter. */
    SseEmitter registerForTest(String userId, int tokenVersion, SseEmitter emitter) {
        return subscribe(userId, tokenVersion, emitter);
    }

    private SseEmitter subscribe(String userId, int tokenVersion, SseEmitter emitter) {
        UUID userUuid;
        try {
            userUuid = UUID.fromString(userId);
        } catch (IllegalArgumentException | NullPointerException failure) {
            throw new CpApiException(HttpStatus.UNAUTHORIZED, "UNAUTHENTICATED",
                    "The user channel needs an authenticated user");
        }
        UserState state = readUserState(userUuid);
        if (state == null || !state.usable() || state.tokenVersion() != tokenVersion) {
            throw new CpApiException(HttpStatus.UNAUTHORIZED, "UNAUTHENTICATED",
                    "The user channel needs an authenticated user");
        }
        Subscriber subscriber = new Subscriber(userUuid, tokenVersion, state.sessionVersion(), emitter);
        emitter.onCompletion(() -> remove(userId, subscriber));
        emitter.onTimeout(() -> remove(userId, subscriber));
        emitter.onError(error -> remove(userId, subscriber));
        synchronized (subscriber) {
            subscribers.compute(userId, (key, current) -> {
                Set<Subscriber> perUser = current == null ? ConcurrentHashMap.newKeySet() : current;
                if (perUser.size() >= MAX_SUBSCRIBERS_PER_USER) {
                    throw new CpApiException(HttpStatus.TOO_MANY_REQUESTS, "USER_CHANNEL_FULL",
                            "At most " + MAX_SUBSCRIBERS_PER_USER + " user-channel connections per user");
                }
                perUser.add(subscriber);
                return perUser;
            });
            sendOne(userId, subscriber, EVENT_CONNECTED, Map.of("serverTime", Instant.now().toString()));
        }
        logger.info("[LIFECYCLE] service=cp event=user_channel_connected userId={} connections={}",
                userId, connectionCount(userId));
        return emitter;
    }

    @Override
    public void participantNotified(String userId, String sessionId, String participantId) {
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("sessionId", sessionId);
        payload.put("participantId", participantId);
        broadcast(userId, EVENT_PARTICIPANT_NOTIFIED, payload);
    }

    @Override
    public void questionChanged(String userId, String questionId, String sessionId, String state) {
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("questionId", questionId);
        payload.put("sessionId", sessionId);
        payload.put("state", state);
        broadcast(userId, EVENT_USER_QUESTION, payload);
    }

    /** Visible for tests: how many live connections this user currently has. */
    int connectionCount(String userId) {
        Set<Subscriber> perUser = subscribers.get(userId);
        return perUser == null ? 0 : perUser.size();
    }

    private void broadcast(String userId, String event, Object payload) {
        if (userId == null || userId.isBlank()) {
            return;
        }
        Set<Subscriber> perUser = subscribers.get(userId);
        if (perUser == null || perUser.isEmpty()) {
            return;
        }
        for (Subscriber subscriber : perUser) {
            sendOne(userId, subscriber, event, payload);
        }
    }

    private void sendOne(String userId, Subscriber subscriber, String event, Object payload) {
        synchronized (subscriber) {
            if (subscriber.closed.get()) {
                return;
            }
            try {
                UserState state = readUserState(subscriber.userId);
                if (state == null || !state.usable() || state.tokenVersion() != subscriber.tokenVersion
                        || state.sessionVersion() != subscriber.sessionVersion) {
                    close(userId, subscriber);
                    return;
                }
                subscriber.emitter.send(SseEmitter.event().name(event).data(payload));
            } catch (IOException | RuntimeException failure) {
                logger.info("[LIFECYCLE] service=cp event=user_channel_send_failed userId={} event={} "
                        + "reason={}", userId, event, failure.getClass().getSimpleName());
                close(userId, subscriber);
            }
        }
    }

    /**
     * Read scalar columns, not a potentially stale managed User. JdbcTemplate joins any caller
     * transaction, avoiding an extra pool connection while WakeDispatchService holds one. At
     * READ_COMMITTED each statement sees the latest committed row. An existing snapshot transaction
     * cannot provide that guarantee, so it fails closed instead of sending with stale credentials.
     * No database row lock is held across the network write; the read is the send's decision point.
     */
    private UserState readUserState(UUID userId) {
        return jdbc.execute((ConnectionCallback<UserState>) connection -> {
            if (!connection.getAutoCommit()
                    && connection.getTransactionIsolation() != Connection.TRANSACTION_READ_COMMITTED) {
                throw new SQLException("User channel requires a current committed user state");
            }
            try (PreparedStatement query = connection.prepareStatement(
                    "SELECT token_version, session_version, status, deleted_at FROM users WHERE id = ?")) {
                query.setQueryTimeout(2);
                query.setObject(1, userId);
                try (ResultSet result = query.executeQuery()) {
                    if (!result.next()) {
                        return null;
                    }
                    return new UserState(result.getInt("token_version"), result.getInt("session_version"),
                            "ACTIVE".equals(result.getString("status")) && result.getObject("deleted_at") == null);
                }
            }
        });
    }

    void sendHeartbeats() {
        for (Map.Entry<String, Set<Subscriber>> entry : subscribers.entrySet()) {
            for (Subscriber subscriber : entry.getValue()) {
                sendOne(entry.getKey(), subscriber, EVENT_CONNECTED,
                        Map.of("serverTime", Instant.now().toString()));
            }
        }
    }

    private void close(String userId, Subscriber subscriber) {
        if (subscriber.closeOnce()) {
            removeFromRegistry(userId, subscriber);
            subscriber.emitter.complete();
        }
    }

    private void remove(String userId, Subscriber subscriber) {
        synchronized (subscriber) {
            if (subscriber.closeOnce()) {
                removeFromRegistry(userId, subscriber);
            }
        }
    }

    private void removeFromRegistry(String userId, Subscriber subscriber) {
        subscribers.computeIfPresent(userId, (key, perUser) -> {
            perUser.remove(subscriber);
            return perUser.isEmpty() ? null : perUser;
        });
    }
}
