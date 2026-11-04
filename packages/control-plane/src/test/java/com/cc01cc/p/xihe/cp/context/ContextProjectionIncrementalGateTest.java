package com.cc01cc.p.xihe.cp.context;

import com.cc01cc.p.xihe.cp.context.entity.ContextEvent;
import com.cc01cc.p.xihe.cp.context.entity.ContextProjection;
import com.cc01cc.p.xihe.cp.context.repository.ContextProjectionRepository;
import com.cc01cc.p.xihe.cp.context.service.ContextProjectionService;
import com.cc01cc.p.xihe.cp.context.service.EventStoreService;
import com.cc01cc.p.xihe.cp.service.BranchPathService;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;
import java.util.Optional;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * BL-305 safety gates for the incremental snapshot path, exercised without a database: the gates
 * that must fall back to the full replay (stored carrier, carrier suffix, rewriting suffix, ahead
 * projection, missing projection) and the one that must not (append-only suffix).
 */
class ContextProjectionIncrementalGateTest {

    private static final String SESSION = "session";
    private static final String BRANCH = "branch";
    private static final String STORED_SEQUENCE = "5";

    private final ObjectMapper json = new ObjectMapper();
    private final EventStoreService events = mock(EventStoreService.class);
    private final ContextProjectionRepository projections = mock(ContextProjectionRepository.class);
    private final ContextProjectionService projector = new ContextProjectionService(
            events, projections, mock(BranchPathService.class), json);
    private long sequence;

    @Test
    void appendOnlySuffixIsAppliedOnTopOfTheStoredProjection() throws Exception {
        store(2L, payload(2L, messages(Map.of("role", "human", "content", "first"))));
        when(events.getLatestSequence(SESSION)).thenReturn(3L);
        sequence = 2;
        when(events.read(SESSION, 2L, null))
                .thenReturn(List.of(event("prompt.admitted", null, Map.of("content", "second"))));

        Optional<ContextProjectionService.IncrementalProjection> incremental =
                projector.tryIncrementalProjection(SESSION, BRANCH, null);

        assertTrue(incremental.isPresent());
        assertEquals(1, incremental.get().suffixEvents());
        assertEquals(2, incremental.get().context().path("messages").size());
        assertEquals(3L, incremental.get().context().path("latest_sequence").asLong());
        assertEquals("second", incremental.get().context().path("messages").get(1).path("content").asText());
    }

    @Test
    void upToDateProjectionReusesStoredPayloadWithoutReadingEvents() {
        store(3L, payload(3L, messages(Map.of("role", "human", "content", "first"))));
        when(events.getLatestSequence(SESSION)).thenReturn(3L);
        when(events.read(SESSION, 3L, null)).thenReturn(List.of());

        Optional<ContextProjectionService.IncrementalProjection> incremental =
                projector.tryIncrementalProjection(SESSION, BRANCH, null);

        assertTrue(incremental.isPresent());
        assertEquals(0, incremental.get().suffixEvents());
        assertEquals(3L, incremental.get().context().path("latest_sequence").asLong());
    }

    @Test
    void storedCarrierForcesFullReplay() {
        store(3L, payload(3L, messages(Map.of(
                "role", "ai", "content", "carrier answer",
                "apiTypeId", "anthropic-messages", "apiTypeVersion", 1,
                "nativeRecords", List.of(Map.of("role", "assistant"))))));
        when(events.getLatestSequence(SESSION)).thenReturn(4L);

        assertFalse(projector.tryIncrementalProjection(SESSION, BRANCH, null).isPresent());
    }

    @Test
    void carrierInSuffixForcesFullReplay() throws Exception {
        store(2L, payload(2L, messages(Map.of("role", "human", "content", "first"))));
        when(events.getLatestSequence(SESSION)).thenReturn(4L);
        when(events.read(SESSION, 2L, null)).thenReturn(List.of(
                event("prompt.admitted", null, Map.of("content", "second")),
                event("assistant.responded", "run-1", Map.of("message", Map.of(
                        "role", "ai", "content", "carrier answer",
                        "apiTypeId", "anthropic-messages", "apiTypeVersion", 1,
                        "nativeRecords", List.of(Map.of("role", "assistant")))))));

        assertFalse(projector.tryIncrementalProjection(SESSION, BRANCH, null).isPresent());
    }

    @Test
    void historyRewritingSuffixForcesFullReplay() throws Exception {
        for (String type : List.of("compaction.applied", "compaction.manual_applied", "context.prune",
                "session.forked", "session.created")) {
            resetStore(2L);
            when(events.read(SESSION, 2L, null)).thenReturn(List.of(event(type, null, Map.of())));
            assertFalse(projector.tryIncrementalProjection(SESSION, BRANCH, null).isPresent(),
                    type + " rewrites earlier facts");
        }
    }

    @Test
    void projectionAheadOfTheEventLogForcesFullReplay() {
        store(9L, payload(9L, messages(Map.of("role", "human", "content", "first"))));
        when(events.getLatestSequence(SESSION)).thenReturn(5L);

        assertFalse(projector.tryIncrementalProjection(SESSION, BRANCH, null).isPresent());
    }

    @Test
    void missingProjectionFallsBack() {
        when(projections.findBySessionIdAndProjectionTypeAndBranchId(SESSION, "agent_context", BRANCH))
                .thenReturn(Optional.empty());
        when(events.getLatestSequence(SESSION)).thenReturn(5L);

        assertFalse(projector.tryIncrementalProjection(SESSION, BRANCH, null).isPresent());
    }

    private void store(long latestSequence, String payload) {
        ContextProjection projection = new ContextProjection(SESSION, "ws", "user", payload);
        projection.setBranchId(BRANCH);
        projection.setLatestSequence(latestSequence);
        when(projections.findBySessionIdAndProjectionTypeAndBranchId(SESSION, "agent_context", BRANCH))
                .thenReturn(Optional.of(projection));
    }

    private void resetStore(long latestSequence) {
        sequence = 0;
        store(latestSequence, payload(latestSequence, messages(Map.of("role", "human", "content", "first"))));
        when(events.getLatestSequence(SESSION)).thenReturn(latestSequence + 1);
    }

    private String payload(long latestSequence, String messages) {
        return "{\"aggregate_id\":\"" + SESSION + "\",\"latest_sequence\":" + latestSequence
                + ",\"messages\":" + messages
                + ",\"epoch\":{},\"runtime_state\":{},\"metadata\":{}}";
    }

    private String messages(Map<String, Object>... entries) {
        StringBuilder builder = new StringBuilder("[");
        for (int index = 0; index < entries.length; index += 1) {
            if (index > 0) {
                builder.append(',');
            }
            builder.append(toJson(entries[index]));
        }
        return builder.append(']').toString();
    }

    private String toJson(Map<String, Object> value) {
        try {
            return json.writeValueAsString(value);
        } catch (Exception exception) {
            throw new IllegalStateException(exception);
        }
    }

    private ContextEvent event(String type, String run, Object payload) throws Exception {
        ContextEvent event = new ContextEvent(SESSION, "ws", "user", type, ++sequence,
                json.writeValueAsString(payload));
        event.setCorrelationId(run);
        return event;
    }
}
