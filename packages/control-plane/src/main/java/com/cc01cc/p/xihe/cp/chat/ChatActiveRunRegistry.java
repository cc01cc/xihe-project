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
    /**
     * task-131: runs this process has <b>parked</b> for transport recovery. They stay in
     * {@link #activeRuns} on purpose — a queued run is still in flight for the Session (compaction
     * must stay deferred, reconciliation must not call it stale) — but nobody is driving them, so
     * the recovery drain is allowed to take them back. Keeping the distinction here, instead of
     * releasing the claim, is what stops the drain from treating "I registered it" as "someone is
     * running it".
     */
    private final Map<String, Set<String>> handedOffRuns = new ConcurrentHashMap<>();
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
        forgetHandedOff(sessionId, runId);
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

    /**
     * task-131: parks a run this process already claimed ("handed off" for transport recovery).
     *
     * @return {@code false} when the run is not claimed by this process at all (nothing to park).
     */
    boolean markHandedOff(String sessionId, String runId) {
        if (!isRunActiveLocally(runId)) {
            return false;
        }
        handedOffIds(sessionId).add(runId);
        return true;
    }

    /**
     * task-131: takes a handed-off run back from the recovery drain.
     *
     * @return {@code true} when this run was parked by this process (the drain may dispatch it, and
     *         it is ACTIVE again), or when nothing is registered for it at all (defensive: the
     *         process lost the registry but kept the queue). {@code false} means a run with this id
     *         is genuinely being driven right now, so a second dispatch must be refused.
     */
    boolean resumeHandedOff(String sessionId, String runId) {
        Set<String> parked = handedOffRuns.get(sessionId);
        if (parked != null && parked.remove(runId)) {
            forgetHandedOff(sessionId, runId);
            runIds(sessionId).add(runId);
            return true;
        }
        return claim(sessionId, runId);
    }

    /** task-131: is this run parked for transport recovery rather than being driven? */
    boolean isHandedOff(String runId) {
        if (runId == null) {
            return false;
        }
        for (Set<String> runIds : handedOffRuns.values()) {
            if (runIds.contains(runId)) {
                return true;
            }
        }
        return false;
    }

    private void forgetHandedOff(String sessionId, String runId) {
        Set<String> runIds = handedOffRuns.get(sessionId);
        if (runIds == null) {
            return;
        }
        runIds.remove(runId);
        if (runIds.isEmpty()) {
            handedOffRuns.remove(sessionId, runIds);
        }
    }

    private Set<String> handedOffIds(String sessionId) {
        return handedOffRuns.computeIfAbsent(sessionId, ignored -> ConcurrentHashMap.newKeySet());
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
