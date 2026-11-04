package com.cc01cc.p.xihe.cp.event;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Component;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import java.io.IOException;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;
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

    public UserChannelSseManager() {
        ScheduledExecutorService heartbeat = Executors.newSingleThreadScheduledExecutor(runnable -> {
            Thread thread = new Thread(runnable, "user-channel-heartbeat");
            thread.setDaemon(true);
            return thread;
        });
        heartbeat.scheduleAtFixedRate(this::sendHeartbeats, HEARTBEAT_SECONDS, HEARTBEAT_SECONDS,
                TimeUnit.SECONDS);
    }

    /** One live connection of one user (a tab). */
    static final class Subscriber {
        private final SseEmitter emitter;
        private final AtomicBoolean closed = new AtomicBoolean(false);

        Subscriber(SseEmitter emitter) {
            this.emitter = emitter;
        }

        SseEmitter emitter() {
            return emitter;
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
    public SseEmitter register(String userId) {
        return subscribe(userId, new SseEmitter(0L));
    }

    /** Test seam: same cap/invariants, but the caller supplies the emitter. */
    SseEmitter registerForTest(String userId, SseEmitter emitter) {
        return subscribe(userId, emitter);
    }

    private SseEmitter subscribe(String userId, SseEmitter emitter) {
        if (userId == null || userId.isBlank()) {
            throw new CpApiException(HttpStatus.UNAUTHORIZED, "UNAUTHENTICATED",
                    "The user channel needs an authenticated user");
        }
        Subscriber subscriber = new Subscriber(emitter);
        Set<Subscriber> perUser = subscribers.computeIfAbsent(userId, key -> ConcurrentHashMap.newKeySet());
        if (perUser.size() >= MAX_SUBSCRIBERS_PER_USER) {
            throw new CpApiException(HttpStatus.TOO_MANY_REQUESTS, "USER_CHANNEL_FULL",
                    "At most " + MAX_SUBSCRIBERS_PER_USER + " user-channel connections per user");
        }
        perUser.add(subscriber);
        emitter.onCompletion(() -> remove(userId, subscriber));
        emitter.onTimeout(() -> remove(userId, subscriber));
        emitter.onError(error -> remove(userId, subscriber));
        sendOne(userId, subscriber, EVENT_CONNECTED, Map.of("serverTime", Instant.now().toString()));
        logger.info("[LIFECYCLE] service=cp event=user_channel_connected userId={} connections={}",
                userId, perUser.size());
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
        try {
            subscriber.emitter().send(SseEmitter.event().name(event).data(payload));
        } catch (IOException | IllegalStateException failure) {
            logger.info("[LIFECYCLE] service=cp event=user_channel_send_failed userId={} event={} "
                    + "reason={}", userId, event, failure.getClass().getSimpleName());
            remove(userId, subscriber);
            if (subscriber.closeOnce()) {
                subscriber.emitter().complete();
            }
        }
    }

    private void sendHeartbeats() {
        for (Map.Entry<String, Set<Subscriber>> entry : subscribers.entrySet()) {
            for (Subscriber subscriber : entry.getValue()) {
                sendOne(entry.getKey(), subscriber, EVENT_CONNECTED,
                        Map.of("serverTime", Instant.now().toString()));
            }
        }
    }

    private void remove(String userId, Subscriber subscriber) {
        Set<Subscriber> perUser = subscribers.get(userId);
        if (perUser != null) {
            perUser.remove(subscriber);
            if (perUser.isEmpty()) {
                subscribers.remove(userId, perUser);
            }
        }
    }
}
