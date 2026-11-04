package com.cc01cc.p.xihe.cp.chat;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

/**
 * PLAN-0670 M2b (T2b.4): a <b>switchable</b> heap watermark for the unbounded read paths.
 *
 * <p>Why: the 20k-message baseline (PLAN-0670 evidence {@code m2b-baseline.md}) showed the CP can
 * allocate ~90 MB for one full conversation read. The hard ceiling
 * ({@code 413 PAGINATION_REQUIRED}) stops the worst case, but a long session that stays just under
 * the cap still deserves a signal <b>before</b> users report "it got slow". This guard emits one WARN
 * line when an estimate crosses the threshold, and stays silent (and off by default) otherwise.</p>
 *
 * <p><b>Privacy:</b> the log line carries the endpoint, the row count, the estimated bytes and the
 * threshold — never message content, ids, or user data.</p>
 *
 * <p>Switch: deployment properties {@code cp.read-memory-guard.enabled} (default {@code false}) and
 * {@code cp.read-memory-guard.threshold-bytes} (default 8 MiB). Disabled means zero logging, so a
 * production deployment opts in deliberately.</p>
 */
@Component
public class SessionReadMemoryGuard {

    private static final Logger logger = LoggerFactory.getLogger(SessionReadMemoryGuard.class);

    /** Default threshold: 8 MiB of estimated response bytes. */
    static final long DEFAULT_THRESHOLD_BYTES = 8L * 1024 * 1024;

    private final boolean enabled;
    private final long thresholdBytes;

    public SessionReadMemoryGuard(
            @Value("${cp.read-memory-guard.enabled:false}") boolean enabled,
            @Value("${cp.read-memory-guard.threshold-bytes:" + DEFAULT_THRESHOLD_BYTES + "}") long thresholdBytes) {
        this.enabled = enabled;
        this.thresholdBytes = thresholdBytes <= 0 ? DEFAULT_THRESHOLD_BYTES : thresholdBytes;
    }

    /** Always-silent instance for tests and paths that must not sample. */
    public static SessionReadMemoryGuard disabled() {
        return new SessionReadMemoryGuard(false, DEFAULT_THRESHOLD_BYTES);
    }

    boolean isEnabled() {
        return enabled;
    }

    /**
     * One WARN line when enabled and the estimate crosses the threshold. Never includes content.
     *
     * @param endpoint       short read-path label (e.g. {@code messages.list}, {@code export})
     * @param messages       number of rows the path is materialising
     * @param estimatedBytes estimate of the response/heap footprint, computed by the caller
     */
    public void observe(String endpoint, long messages, long estimatedBytes) {
        if (!shouldEmit(estimatedBytes)) {
            return;
        }
        logger.warn("[LIFECYCLE] service=cp {}", describe(endpoint, messages, estimatedBytes));
    }

    /** Enabled AND at/over the threshold — the only case that emits a line. */
    boolean shouldEmit(long estimatedBytes) {
        return enabled && estimatedBytes >= thresholdBytes;
    }

    /** The exact log payload — package-private so the test can assert it without a logging appender. */
    String describe(String endpoint, long messages, long estimatedBytes) {
        return "event=session_read_memory_guard endpoint=" + endpoint
                + " messages=" + messages
                + " estBytes=" + estimatedBytes
                + " thresholdBytes=" + thresholdBytes;
    }
}
