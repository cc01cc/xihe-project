package com.cc01cc.p.xihe.cp.context.service;

/**
 * PLAN-0470 #24/D1b: the narrow notification seam Context uses to surface
 * compaction-circuit changes to the session UI. Implemented by the existing
 * SSE sender (chat SseEmitterManager); Context depends only on this port, so
 * the context→chat dependency is severed at the source. The wire contract
 * ({@code context_compaction_circuit} and its payload) is unchanged — this
 * interface does not invent a new bus, event store, or delivery semantics.
 */
public interface CompactionNoticePort {

    /** Fire-and-forget; failures are logged by the implementation, never thrown. */
    void sendCompactionNotice(String sessionId, String state, String reason);
}
