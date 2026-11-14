package com.cc01cc.p.xihe.cp.observability;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.atomic.AtomicLong;
import java.util.function.LongSupplier;
import org.junit.jupiter.api.Test;

/**
 * task-597 判据 2/3：接线后失败可见；读数为 0 时能区分「没失败」与「没接线」。
 */
class AuditFailOpenMetricsTest {

    private final SimpleMeterRegistry registry = new SimpleMeterRegistry();

    @Test
    void zeroFailureReadingDiffersFromMissingWiring() {
        AtomicLong created = new AtomicLong();
        Map<String, LongSupplier> partial = new LinkedHashMap<>();
        partial.put("workspace_created", created::get);
        new AuditFailOpenMetrics(registry, partial);

        assertEquals(0.0, value(AuditFailOpenMetrics.METRIC_PREFIX + "failures",
                "workspace_created"), "no failure yet");
        assertEquals(1.0, simple(AuditFailOpenMetrics.METRIC_PREFIX + "wiring.registered"));
        assertEquals((double) AuditFailOpenMetrics.COMPONENTS.size(),
                simple(AuditFailOpenMetrics.METRIC_PREFIX + "wiring.expected"));
        assertEquals(3.0, simple(AuditFailOpenMetrics.METRIC_PREFIX + "wiring.incomplete"),
                "one of four counters is wired => 0 failures is NOT readable as 'no failure'");
    }

    @Test
    void failureBumpsTheCounterAndFullWiringReportsZeroIncomplete() {
        Map<String, LongSupplier> full = new LinkedHashMap<>();
        full.put("workspace_created", new AtomicLong()::get);
        full.put("session_snapshot", new AtomicLong()::get);
        AtomicLong revert = new AtomicLong();
        full.put("checkpoint_revert", revert::get);
        AtomicLong unwired = new AtomicLong();
        full.put("checkpoint_revert_unwired", unwired::get);
        AuditFailOpenMetrics metrics = new AuditFailOpenMetrics(registry, full);

        assertEquals(0.0, simple(AuditFailOpenMetrics.METRIC_PREFIX + "wiring.incomplete"),
                "wiring complete => a 0 failure reading means 'no failure'");
        assertEquals(4, metrics.wiredComponents().size());

        revert.incrementAndGet();
        assertEquals(1.0, value(AuditFailOpenMetrics.METRIC_PREFIX + "failures", "checkpoint_revert"));
        assertEquals(0.0, value(AuditFailOpenMetrics.METRIC_PREFIX + "failures", "session_snapshot"),
                "the other counters keep their own zero");

        unwired.set(2);
        assertEquals(2.0, value(AuditFailOpenMetrics.METRIC_PREFIX + "failures",
                "checkpoint_revert_unwired"));
        assertTrue(AuditFailOpenMetrics.COMPONENTS.containsAll(metrics.wiredComponents()));
    }

    @Test
    void everyExpectedComponentHasANameToQuery() {
        assertEquals(4, AuditFailOpenMetrics.COMPONENTS.size());
        assertTrue(AuditFailOpenMetrics.METRIC_PREFIX.startsWith("xihe.audit.fail_open."));
    }

    private double simple(String name) {
        return registry.get(name).gauge().value();
    }

    private double value(String name, String component) {
        return registry.get(name).tag("component", component).gauge().value();
    }
}
