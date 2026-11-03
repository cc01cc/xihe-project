package com.cc01cc.p.xihe.cp.chat;

import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import org.springframework.stereotype.Component;

/**
 * Session→Run active-run registry shared by ChatController and the
 * recovery / reconciliation / session adapters (PLAN-0470 Session/Chat S1).
 *
 * <p>PLAN-0645 (D45-02): one Session may drive several in-flight Runs, so the
 * registry keeps a <b>set</b> of run ids per Session instead of a single slot.
 * Two consequences are deliberate:</p>
 * <ul>
 *   <li>it is <b>not</b> an admission gate any more — the bounded-concurrency
 *       decision lives in {@link SessionRunConcurrencyGate} under the Session
 *       row lock. This registry only answers "which runs is this process
 *       driving?";</li>
 *   <li>non-run local serialization (the Follow-up queue admission) uses
 *       {@link #tryReserve}/{@link #releaseReservation} with its own key, so an
 *       unrelated in-flight Run can never block the queue drain.</li>
 * </ul>
 */
@Component
public class ChatActiveRunRegistry {

    private final Map<String, Set<String>> activeRuns = new ConcurrentHashMap<>();
    private final Map<String, String> reservations = new ConcurrentHashMap<>();

    /**
     * Registers {@code runId} as locally active for the Session.
     *
     * @return {@code false} when this exact run was already claimed (another
     *         thread is already dispatching it); {@code true} on first claim.
     */
    boolean claim(String sessionId, String runId) {
        return runIds(sessionId).add(runId);
    }

    boolean release(String sessionId, String runId) {
        Set<String> runIds = activeRuns.get(sessionId);
        if (runIds == null) {
            return false;
        }
        boolean removed = runIds.remove(runId);
        if (runIds.isEmpty()) {
            activeRuns.remove(sessionId, runIds);
        }
        return removed;
    }

    /** Startup recovery: the run survived a restart and is being resumed by this process. */
    void restore(String sessionId, String runId) {
        runIds(sessionId).add(runId);
    }

    /** PLAN-0645: "this Session has at least one run in flight in this process". */
    boolean hasActive(String sessionId) {
        Set<String> runIds = activeRuns.get(sessionId);
        return runIds != null && !runIds.isEmpty();
    }

    /** Snapshot of the locally active run ids for one Session (tests/observability). */
    Set<String> activeRunIds(String sessionId) {
        Set<String> runIds = activeRuns.get(sessionId);
        return runIds == null ? Set.of() : Set.copyOf(runIds);
    }

    /** PLAN-0317 T2.7：该 run 是否正由本进程处理（周期对账的防误伤保护）。 */
    boolean isRunActiveLocally(String runId) {
        if (runId == null) {
            return false;
        }
        for (Set<String> runIds : activeRuns.values()) {
            if (runIds.contains(runId)) {
                return true;
            }
        }
        return false;
    }

    /**
     * PLAN-0645 D45-06: local-only serialization token for work that is not a
     * Run (the Follow-up queue admission for one Session). Kept apart from the
     * run sets on purpose: the queue has its own single-active-child rule and
     * must not compete with unrelated Runs for a Session-wide slot.
     */
    boolean tryReserve(String key, String token) {
        return reservations.putIfAbsent(key, token) == null;
    }

    boolean ownsReservation(String key, String token) {
        return token != null && token.equals(reservations.get(key));
    }

    boolean releaseReservation(String key, String token) {
        return reservations.remove(key, token);
    }

    private Set<String> runIds(String sessionId) {
        return activeRuns.computeIfAbsent(sessionId, ignored -> ConcurrentHashMap.newKeySet());
    }
}
