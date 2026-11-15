package com.cc01cc.p.xihe.cp.observability;

import com.cc01cc.p.xihe.cp.status.RequestQueue;
import io.micrometer.core.instrument.Gauge;
import io.micrometer.core.instrument.MeterRegistry;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Component;

/**
 * task-134 A3: the parked-request queue had no reader anywhere in {@code src/main} — a request that
 * got wedged there was invisible (no gauge, no log). This exposes its depth.
 *
 * <p>Reading it does not change behaviour; it only makes "something is sitting in the queue" a
 * number instead of a guess. The field keeps a strong reference so the gauge cannot be collected
 * away by Micrometer's weak-reference registry.</p>
 */
@Component
public class ChatQueueDepthMetrics {

    static final String GAUGE = "xihe.chat.queue.depth";

    private final Gauge depth;

    @Autowired
    public ChatQueueDepthMetrics(MeterRegistry registry, RequestQueue requestQueue) {
        this.depth = Gauge.builder(GAUGE, requestQueue, RequestQueue::size)
                .description("Chat requests parked waiting for the agent transport to recover")
                .register(registry);
    }

    Gauge depth() {
        return depth;
    }
}
