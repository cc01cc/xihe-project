package com.cc01cc.p.xihe.cp.observability;

import com.cc01cc.p.xihe.cp.status.RequestQueue;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;

/** task-134 A3: a wedged request must be visible as a number, not only as a log line. */
class ChatQueueDepthMetricsTest {

    @Test
    void gaugeReportsHowManyRequestsAreParked() {
        SimpleMeterRegistry registry = new SimpleMeterRegistry();
        RequestQueue queue = new RequestQueue();
        new ChatQueueDepthMetrics(registry, queue);

        assertEquals(0.0, registry.get(ChatQueueDepthMetrics.GAUGE).gauge().value());

        queue.enqueue("s1", "hello", null, "user1", "ws1");

        assertEquals(1.0, registry.get(ChatQueueDepthMetrics.GAUGE).gauge().value());
    }
}
