package com.cc01cc.p.xihe.cp.chat;

import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import org.springframework.stereotype.Component;

/**
 * Session→Run active-run registry shared by ChatController and the
 * recovery / reconciliation / session adapters (PLAN-0470 Session/Chat S1).
 *
 * Ownership moved out of the HTTP adapter; semantics are unchanged —
 * reservation put/replace, lease-coupled release and SSE ordering all stay
 * in ChatController, which keeps operating on this single registry instance.
 */
@Component
public class ChatActiveRunRegistry {

    private final Map<String, String> activeRuns = new ConcurrentHashMap<>();

    String putIfAbsent(String sessionId, String runId) {
        return activeRuns.putIfAbsent(sessionId, runId);
    }

    boolean remove(String sessionId, String runId) {
        return activeRuns.remove(sessionId, runId);
    }

    String get(String sessionId) {
        return activeRuns.get(sessionId);
    }

    void put(String sessionId, String runId) {
        activeRuns.put(sessionId, runId);
    }

    boolean replace(String sessionId, String expectedRunId, String runId) {
        return activeRuns.replace(sessionId, expectedRunId, runId);
    }

    void restoreActiveRun(String sessionId, String runId) {
        activeRuns.put(sessionId, runId);
    }

    String activeRunId(String sessionId) {
        return activeRuns.get(sessionId);
    }

    /** PLAN-0317 T2.7：该 run 是否正由本进程处理（周期对账的防误伤保护）。 */
    boolean isRunActiveLocally(String runId) {
        return runId != null && activeRuns.containsValue(runId);
    }
}
