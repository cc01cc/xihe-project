package com.cc01cc.p.xihe.cp.chat;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import java.io.IOException;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * SseEmitterManager manages SSE connections for UI chat.
 * Each message gets its own emitter, stored in a map.
 */
@Component
public class SseEmitterManager {

    private static final Logger logger = LoggerFactory.getLogger(SseEmitterManager.class);

    private final Map<String, SseEmitter> emitters = new ConcurrentHashMap<>();

    public SseEmitter createEmitter(String sessionId) {
        SseEmitter previousEmitter = emitters.remove(sessionId);
        if (previousEmitter != null) {
            previousEmitter.complete();
        }

        SseEmitter emitter = new SseEmitter(0L);

        emitter.onCompletion(() -> emitters.remove(sessionId));
        emitter.onTimeout(() -> emitters.remove(sessionId));
        emitter.onError(e -> emitters.remove(sessionId));

        emitters.put(sessionId, emitter);
        logger.info("SSE emitter registered for session={}", sessionId);
        return emitter;
    }

    public boolean send(String sessionId, String eventName, Object data) {
        SseEmitter emitter = emitters.get(sessionId);
        if (emitter != null) {
            try {
                emitter.send(SseEmitter.event()
                    .name(eventName)
                    .data(data));
                logger.debug("SSE event delivered session={} event={}", sessionId, eventName);
                return true;
            } catch (IOException e) {
                logger.warn("Failed to send SSE event session={} event={} error={}", sessionId, eventName, e.getMessage());
                emitters.remove(sessionId);
                return false;
            }
        } else {
            logger.debug("No active SSE emitter for session={} event={}", sessionId, eventName);
            return false;
        }
    }

    public void complete(String sessionId) {
        SseEmitter emitter = emitters.remove(sessionId);
        if (emitter != null) {
            emitter.complete();
            logger.info("SSE emitter completed for session={}", sessionId);
        }
    }

    public boolean hasEmitter(String sessionId) {
        return emitters.containsKey(sessionId);
    }
}
