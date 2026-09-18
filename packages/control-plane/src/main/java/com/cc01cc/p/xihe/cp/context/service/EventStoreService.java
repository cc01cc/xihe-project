package com.cc01cc.p.xihe.cp.context.service;

import com.cc01cc.p.xihe.cp.config.DbLockTimeout;
import com.cc01cc.p.xihe.cp.context.entity.ContextEvent;
import com.cc01cc.p.xihe.cp.context.repository.EventStoreRepository;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

@Service
public class EventStoreService {

    private static final Logger logger = LoggerFactory.getLogger(EventStoreService.class);

    private final EventStoreRepository eventStoreRepository;
    private final SessionRepository sessionRepository;
    private final ObjectMapper objectMapper;
    private final DbLockTimeout dbLockTimeout;

    public EventStoreService(EventStoreRepository eventStoreRepository,
                             SessionRepository sessionRepository,
                             ObjectMapper objectMapper,
                             DbLockTimeout dbLockTimeout) {
        this.eventStoreRepository = eventStoreRepository;
        this.sessionRepository = sessionRepository;
        this.objectMapper = objectMapper;
        this.dbLockTimeout = dbLockTimeout;
    }

    // PLAN-0346 (gap E): context_events sequence allocation previously ran
    // unlocked (getLatest+1 → insert), so two concurrent appends to one session
    // (e.g. assistant.responded vs the llm.usage mirror at run settle) could
    // both compute the same sequence and one INSERT died on the unique index —
    // silent event loss. Lock the session row first, mirroring the ledger's
    // operation-row lock (0317 decision #7②). Cross-session writes stay parallel.
    private void lockSessionForSequence(UUID sessionId) {
        sessionRepository.findByIdForUpdate(sessionId)
                .orElseThrow(() -> new IllegalArgumentException("Session not found: " + sessionId));
    }

    @Transactional
    public ContextEvent append(String sessionId, String workspaceId, String userId,
                                String eventType, Object payload) {
        dbLockTimeout.apply();
        lockSessionForSequence(UUID.fromString(sessionId));
        Long nextSequence = getLatestSequence(sessionId) + 1;
        String payloadJson = toJson(payload);
        ContextEvent event = new ContextEvent(sessionId, workspaceId, userId, eventType, nextSequence, payloadJson);
        return eventStoreRepository.save(event);
    }

    @Transactional
    public List<ContextEvent> appendBatch(String sessionId, String workspaceId, String userId,
                                          List<EventPayload> payloads) {
        dbLockTimeout.apply();
        lockSessionForSequence(UUID.fromString(sessionId));
        Long nextSequence = getLatestSequence(sessionId) + 1;
        List<ContextEvent> events = new java.util.ArrayList<>();
        for (int i = 0; i < payloads.size(); i++) {
            EventPayload ep = payloads.get(i);
            String payloadJson = toJson(ep.payload());
            ContextEvent event = new ContextEvent(sessionId, workspaceId, userId, ep.eventType(), nextSequence + i, payloadJson);
            events.add(event);
        }
        return eventStoreRepository.saveAll(events);
    }

    @Transactional(readOnly = true)
    public List<ContextEvent> read(String sessionId, Long afterSequence) {
        if (afterSequence == null || afterSequence <= 0) {
            return eventStoreRepository.findBySessionIdOrderBySequenceAsc(sessionId);
        }
        return eventStoreRepository.findBySessionIdAndSequenceGreaterThanOrderBySequenceAsc(sessionId, afterSequence);
    }

    @Transactional(readOnly = true)
    public Long getLatestSequence(String sessionId) {
        Optional<ContextEvent> latest = eventStoreRepository.findTopBySessionIdOrderBySequenceDesc(sessionId);
        return latest.map(ContextEvent::getSequence).orElse(0L);
    }

    @Transactional
    public Long fork(String sourceSessionId, Long atSequence, String newSessionId,
                     String workspaceId, String userId) {
        dbLockTimeout.apply();
        List<ContextEvent> sourceEvents = eventStoreRepository.findBySessionIdAndSequenceGreaterThanOrderBySequenceAsc(
                sourceSessionId, 0L);
        Long latestSequence = 0L;
        for (ContextEvent source : sourceEvents) {
            if (source.getSequence() > atSequence) {
                break;
            }
            ContextEvent copy = new ContextEvent(
                    newSessionId, workspaceId, userId,
                    source.getEventType(), source.getSequence(), source.getPayload()
            );
            copy.setCorrelationId(source.getCorrelationId());
            copy.setCausationId(source.getCausationId());
            eventStoreRepository.save(copy);
            latestSequence = copy.getSequence();
        }
        return latestSequence;
    }

    private String toJson(Object payload) {
        if (payload == null) {
            return "{}";
        }
        try {
            return objectMapper.writeValueAsString(payload);
        } catch (JsonProcessingException e) {
            logger.error("Failed to serialize event payload", e);
            return "{}";
        }
    }

    public record EventPayload(String eventType, Object payload) {}
}
