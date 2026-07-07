package com.cc01cc.p.xihe.cp.context;

import com.cc01cc.p.xihe.cp.AbstractH2Test;
import com.cc01cc.p.xihe.cp.context.service.EventStoreService;
import org.junit.jupiter.api.Test;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Performance smoke test for the CP Event Store.
 *
 * <p>The goal is to decide whether synchronous batch writes are fast enough
 * for M3 or whether an async write path is required. Results are logged so the
 * decision is data-driven.
 */
class EventStoreServicePerformanceTest extends AbstractH2Test {

    private static final Logger LOGGER = LoggerFactory.getLogger(EventStoreServicePerformanceTest.class);
    private static final int EVENT_COUNT = 1000;

    @Autowired
    private EventStoreService eventStoreService;

    @Test
    void appendIndividualVsAppendBatchBatchIsFaster() {
        String sessionId = UUID.randomUUID().toString();
        String workspaceId = UUID.randomUUID().toString();
        String userId = UUID.randomUUID().toString();

        long individualStart = System.nanoTime();
        for (int i = 0; i < EVENT_COUNT; i++) {
            eventStoreService.append(
                    sessionId, workspaceId, userId,
                    "prompt.admitted", Map.of("content", "event " + i)
            );
        }
        long individualNanos = System.nanoTime() - individualStart;

        String batchSessionId = UUID.randomUUID().toString();
        List<EventStoreService.EventPayload> payloads = new ArrayList<>(EVENT_COUNT);
        for (int i = 0; i < EVENT_COUNT; i++) {
            payloads.add(new EventStoreService.EventPayload(
                    "prompt.admitted", Map.of("content", "event " + i)
            ));
        }
        long batchStart = System.nanoTime();
        List<?> batched = eventStoreService.appendBatch(
                batchSessionId, workspaceId, userId, payloads
        );
        long batchNanos = System.nanoTime() - batchStart;

        assertThat(batched).hasSize(EVENT_COUNT);
        long individualEventsPerSecond = eventsPerSecond(EVENT_COUNT, individualNanos);
        long batchEventsPerSecond = eventsPerSecond(EVENT_COUNT, batchNanos);

        LOGGER.info(
                "EventStore performance: individual={}ms ({} events/s), batch={}ms ({} events/s)",
                nanosToMillis(individualNanos), individualEventsPerSecond,
                nanosToMillis(batchNanos), batchEventsPerSecond
        );

        // Batch writes must be significantly faster than individual writes.
        assertThat(batchNanos)
                .withFailMessage("Batch append should be at least 5x faster than individual appends")
                .isLessThan(individualNanos / 5);
    }

    private static long eventsPerSecond(int count, long nanos) {
        if (nanos == 0) {
            return Long.MAX_VALUE;
        }
        return Math.round(count / (nanos / 1_000_000_000.0));
    }

    private static long nanosToMillis(long nanos) {
        return Math.round(nanos / 1_000_000.0);
    }
}
