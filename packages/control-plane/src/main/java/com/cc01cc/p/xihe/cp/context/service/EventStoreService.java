package com.cc01cc.p.xihe.cp.context.service;

import com.cc01cc.p.xihe.cp.context.entity.ContextEvent;
import com.cc01cc.p.xihe.cp.context.repository.EventStoreRepository;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;
import java.util.Optional;

@Service
public class EventStoreService {

    private static final Logger logger = LoggerFactory.getLogger(EventStoreService.class);

    private final EventStoreRepository eventStoreRepository;
    private final ObjectMapper objectMapper;

    public EventStoreService(EventStoreRepository eventStoreRepository, ObjectMapper objectMapper) {
        this.eventStoreRepository = eventStoreRepository;
        this.objectMapper = objectMapper;
    }

    @Transactional
    public ContextEvent append(String sessionId, String workspaceId, String userId,
                                String eventType, Object payload) {
        Long nextSequence = getLatestSequence(sessionId) + 1;
        String payloadJson = toJson(payload);
        ContextEvent event = new ContextEvent(sessionId, workspaceId, userId, eventType, nextSequence, payloadJson);
        return eventStoreRepository.save(event);
    }

    @Transactional
    public List<ContextEvent> appendBatch(String sessionId, String workspaceId, String userId,
                                          List<EventPayload> payloads) {
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
