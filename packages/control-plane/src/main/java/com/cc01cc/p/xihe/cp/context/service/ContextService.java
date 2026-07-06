package com.cc01cc.p.xihe.cp.context.service;

import com.cc01cc.p.xihe.cp.context.entity.ContextEvent;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;

@Service
public class ContextService {

    private final EventStoreService eventStoreService;
    private final ContextProjectionService projectionService;

    public ContextService(EventStoreService eventStoreService,
                          ContextProjectionService projectionService) {
        this.eventStoreService = eventStoreService;
        this.projectionService = projectionService;
    }

    @Transactional
    public ContextEvent appendEvent(String sessionId, String workspaceId, String userId,
                                    String eventType, Object payload) {
        return eventStoreService.append(sessionId, workspaceId, userId, eventType, payload);
    }

    @Transactional
    public List<ContextEvent> appendBatch(String sessionId, String workspaceId, String userId,
                                          List<EventStoreService.EventPayload> payloads) {
        return eventStoreService.appendBatch(sessionId, workspaceId, userId, payloads);
    }

    @Transactional(readOnly = true)
    public ObjectNode getSnapshot(String sessionId, String workspaceId, String userId, Long afterSequence) {
        // Optionally persist projection on read; for now we project on demand.
        return projectionService.projectAndSave(sessionId, workspaceId, userId);
    }

    @Transactional(readOnly = true)
    public List<ContextEvent> readEvents(String sessionId, Long afterSequence) {
        return eventStoreService.read(sessionId, afterSequence);
    }

    @Transactional(readOnly = true)
    public Long getLatestSequence(String sessionId) {
        return eventStoreService.getLatestSequence(sessionId);
    }

    @Transactional
    public Long fork(String sourceSessionId, Long atSequence, String newSessionId,
                     String workspaceId, String userId) {
        return eventStoreService.fork(sourceSessionId, atSequence, newSessionId, workspaceId, userId);
    }
}
