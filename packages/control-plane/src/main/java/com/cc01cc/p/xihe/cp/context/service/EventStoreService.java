package com.cc01cc.p.xihe.cp.context.service;

import com.cc01cc.p.xihe.cp.config.DbLockTimeout;
import com.cc01cc.p.xihe.cp.context.entity.ContextEvent;
import com.cc01cc.p.xihe.cp.context.repository.EventStoreRepository;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.cc01cc.p.xihe.cp.service.BranchPathService;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;

@Service
public class EventStoreService {

    private static final Logger logger = LoggerFactory.getLogger(EventStoreService.class);

    private final EventStoreRepository eventStoreRepository;
    private final SessionRepository sessionRepository;
    private final ObjectMapper objectMapper;
    private final DbLockTimeout dbLockTimeout;
    private final BranchPathService branchPathService;

    public EventStoreService(EventStoreRepository eventStoreRepository,
                             SessionRepository sessionRepository,
                             ObjectMapper objectMapper,
                             DbLockTimeout dbLockTimeout,
                             BranchPathService branchPathService) {
        this.eventStoreRepository = eventStoreRepository;
        this.sessionRepository = sessionRepository;
        this.objectMapper = objectMapper;
        this.dbLockTimeout = dbLockTimeout;
        this.branchPathService = branchPathService;
    }

    // PLAN-0346 (gap E): context_events sequence allocation previously ran
    // unlocked (getLatest+1 → insert), so two concurrent appends to one session
    // (e.g. assistant.responded vs the llm.usage mirror at run settle) could
    // both compute the same sequence and one INSERT died on the unique index —
    // silent event loss. Lock the session row first, mirroring the ledger's
    // operation-row lock (0317 decision #7②). Cross-session writes stay parallel.
    //
    // The lock is taken only when the anchor row exists: a missing session has
    // no sequence timeline to serialize, and on PostgreSQL the insert is
    // rejected by fk_context_events_session anyway (H2 legacy tests operate
    // without session rows).
    private void lockSessionForSequence(UUID sessionId) {
        sessionRepository.findByIdForUpdate(sessionId);
    }

    @Transactional
    public ContextEvent append(String sessionId, String workspaceId, String userId,
                               String eventType, Object payload) {
        return append(sessionId, workspaceId, userId, eventType, payload, null);
    }

    /**
     * PLAN-0410 T1.4: a non-blank {@code correlation_id} must resolve to a
     * ChatRun of the SAME Session before anything is written (fail-closed, no
     * Event row on failure); the resolved branch is derived from that durable
     * Run. Session/global appends keep both slots NULL.
     */
    @Transactional
    public ContextEvent append(String sessionId, String workspaceId, String userId,
                               String eventType, Object payload, String correlationId) {
        dbLockTimeout.apply();
        String branchId = resolveBranchForCorrelation(sessionId, correlationId);
        lockSessionForSequence(UUID.fromString(sessionId));
        Long nextSequence = getLatestSequence(sessionId) + 1;
        String payloadJson = toJson(payload);
        ContextEvent event = new ContextEvent(sessionId, workspaceId, userId, eventType, nextSequence, payloadJson);
        event.setCorrelationId(correlationId);
        event.setBranchId(branchId);
        return eventStoreRepository.save(event);
    }

    @Transactional
    public List<ContextEvent> appendBatch(String sessionId, String workspaceId, String userId,
                                          List<EventPayload> payloads) {
        dbLockTimeout.apply();
        Map<String, String> branchByRun = new HashMap<>();
        for (EventPayload ep : payloads) {
            if (ep.correlationId() != null && !ep.correlationId().isBlank()) {
                branchByRun.computeIfAbsent(ep.correlationId(),
                        runId -> branchPathService.deriveBranchForRun(sessionId, runId));
            }
        }
        lockSessionForSequence(UUID.fromString(sessionId));
        Long nextSequence = getLatestSequence(sessionId) + 1;
        List<ContextEvent> events = new java.util.ArrayList<>();
        for (int i = 0; i < payloads.size(); i++) {
            EventPayload ep = payloads.get(i);
            String payloadJson = toJson(ep.payload());
            ContextEvent event = new ContextEvent(sessionId, workspaceId, userId, ep.eventType(), nextSequence + i, payloadJson);
            event.setCorrelationId(ep.correlationId());
            boolean runScoped = ep.correlationId() != null && !ep.correlationId().isBlank();
            event.setBranchId(runScoped ? branchByRun.get(ep.correlationId()) : null);
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
            // PLAN-0410 spec §7 (M0 frozen disposition): a copied correlation
            // must resolve to a ChatRun of the TARGET Session. Otherwise the
            // whole fork aborts here — never silently cleared, never kept as an
            // unresolvable orphan row.
            if (source.getCorrelationId() != null && !source.getCorrelationId().isBlank()) {
                copy.setBranchId(branchPathService.deriveBranchForRun(newSessionId, source.getCorrelationId()));
            }
            eventStoreRepository.save(copy);
            latestSequence = copy.getSequence();
        }
        return latestSequence;
    }

    private String resolveBranchForCorrelation(String sessionId, String correlationId) {
        if (correlationId == null || correlationId.isBlank()) {
            return null;
        }
        return branchPathService.deriveBranchForRun(sessionId, correlationId);
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

    public record EventPayload(String eventType, Object payload, String correlationId) {
        public EventPayload(String eventType, Object payload) {
            this(eventType, payload, null);
        }
    }
}
