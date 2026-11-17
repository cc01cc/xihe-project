package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.config.ConfigService;
import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.entity.ChatRun;
import com.cc01cc.p.xihe.cp.repository.ChatApprovalRepository;
import com.cc01cc.p.xihe.cp.repository.ChatRunRepository;
import com.cc01cc.p.xihe.cp.repository.UserQuestionRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Component;

import java.util.List;

/**
 * PLAN-0645 (D45-01): the single owner of "how many ChatRuns may one Session have
 * in flight".
 *
 * <p>Before PLAN-0645 the Session had exactly one in-flight Run, enforced twice:
 * the JVM map in {@link ChatActiveRunRegistry} and an existence check inside
 * {@code ChatSubmissionService}. The JVM map cannot express "up to N" (and never
 * covered multi-instance), so the authoritative check is this count, evaluated
 * <b>while the caller already holds the Session row lock</b>
 * ({@code findByIdForUpdate}), inside the same transaction that inserts the run.
 * That is what makes it atomic across requests and instances without adding a DB
 * constraint — SQL cannot express "at most N rows in non-terminal status" with a
 * unique index.</p>
 *
 * <p>task-161 / D-1786 面 A: the admission count no longer counts
 * <b>waiting-for-human</b> Runs. A Run blocked on a pending user question or a live
 * approval holds no execution slot, so "two agents asked simultaneously, the third
 * message 409s" is gone. The formal model lives in
 * {@code internal/A03-xihe/evidence/2026-11-17-candidate-a-admission-cost/README.md §7}:
 * every non-terminal Run is exactly one of <em>waiting</em> (human input pending),
 * <em>parked</em> (queued for resume, see {@link RunDispatchQueue}), or
 * <em>executing</em>; admission requires {@code executing + parked < cap} —
 * parked entries double as virtual slots, so "no jumping the queue" falls out of
 * the count instead of needing a separate rule (D-1801 ruling ②③).</p>
 *
 * <p>The cap is {@code agent-runtime.maxConcurrentRunsPerSession} (instance-only,
 * default 2, range 1–4). {@code cap=1} reproduces the frozen single-flight
 * behaviour exactly, which is why the rollback is one config write and not a code
 * switch. Unreadable/invalid values fall back to the default with a warning: this
 * is a resource-admission valve, not a security boundary, so a misconfigured value
 * must not fail every chat. The cap NUMBER is user-owned (D-1798) — this class
 * never changes it.</p>
 *
 * <p>Snapshot honesty (§3.3 of the evidence): the waiting probe reads
 * {@code user_questions}/{@code approval_requests}, whose writers do not take the
 * Session row lock, so the classification is a point-in-time snapshot. That is
 * sufficient: the hard bound {@code executing ≤ cap} is enforced structurally by
 * the resume gate ({@link #canResume}) plus the drain, not by this admission
 * snapshot.</p>
 */
@Component
public class SessionRunConcurrencyGate {

    static final int DEFAULT_MAX_CONCURRENT_RUNS = 2;
    static final int MAX_CONCURRENT_RUNS_CEILING = 4;
    static final String CONFIG_DOMAIN = "agent-runtime";
    static final String CONFIG_KEY = "maxConcurrentRunsPerSession";

    /**
     * Live human-interaction states on the approval side; identical to
     * {@code UserQuestionService.APPROVAL_LIVE_STATES} (kept private there), so a
     * run with any of these owns — and is blocked by — a human slot.
     */
    private static final List<String> APPROVAL_LIVE_STATES =
            List.of("pending", "dispatching", "dispatch_unknown");

    private static final Logger logger = LoggerFactory.getLogger(SessionRunConcurrencyGate.class);

    private final ChatRunRepository chatRuns;
    private final UserQuestionRepository questions;
    private final ChatApprovalRepository approvals;
    private final RunDispatchQueue dispatchQueue;
    private final ConfigService configService;

    public SessionRunConcurrencyGate(ChatRunRepository chatRuns,
                                     UserQuestionRepository questions,
                                     ChatApprovalRepository approvals,
                                     RunDispatchQueue dispatchQueue,
                                     ConfigService configService) {
        this.chatRuns = chatRuns;
        this.questions = questions;
        this.approvals = approvals;
        this.dispatchQueue = dispatchQueue;
        this.configService = configService;
    }

    /** Configured cap; invalid or unreadable values fall back to the default. */
    int maxConcurrentRuns() {
        try {
            String configured = configService == null ? null
                    : configService.resolve(CONFIG_DOMAIN, CONFIG_KEY, null, null);
            if (configured == null) {
                return DEFAULT_MAX_CONCURRENT_RUNS;
            }
            int parsed = Integer.parseInt(configured.trim());
            if (parsed < 1 || parsed > MAX_CONCURRENT_RUNS_CEILING) {
                logger.warn("[LIFECYCLE] service=cp event=chat_session_run_cap_invalid configured={} fallback={}",
                        configured, DEFAULT_MAX_CONCURRENT_RUNS);
                return DEFAULT_MAX_CONCURRENT_RUNS;
            }
            return parsed;
        } catch (RuntimeException unreadable) {
            logger.warn("[LIFECYCLE] service=cp event=chat_session_run_cap_unreadable failureType={} fallback={}",
                    unreadable.getClass().getSimpleName(), DEFAULT_MAX_CONCURRENT_RUNS);
            return DEFAULT_MAX_CONCURRENT_RUNS;
        }
    }

    /**
     * Waiting-for-human: the run is blocked on a human answer, so it occupies no
     * admission slot. Definition (evidence §7.1): {@code awaiting_approval} status,
     * or a pending user question, or a live approval request. A parked run is never
     * waiting: its human interaction was already answered/decided.
     */
    private boolean isWaiting(ChatRun run) {
        if ("awaiting_approval".equals(run.getStatus())) {
            return true;
        }
        if (questions.existsByRunIdAndState(run.getId(), "pending")) {
            return true;
        }
        return !approvals.findByRunIdAndStateIn(run.getId().toString(), APPROVAL_LIVE_STATES).isEmpty();
    }

    /**
     * Admission occupancy {@code E + Q}: every non-terminal Run that is not
     * waiting — executing and parked alike. Parked entries count as virtual slots
     * so a queued resume cannot be jumped by a fresh admission (D-1801 ②③).
     * This is the number the admission gate compares against the cap.
     */
    int admissionOccupancy(String sessionId) {
        int occupancy = 0;
        for (ChatRun run : chatRuns.findBySessionIdAndStatusIn(
                sessionId, ChatRunCancellationService.NON_TERMINAL_STATUSES)) {
            if (!isWaiting(run)) {
                occupancy++;
            }
        }
        return occupancy;
    }

    /**
     * Executing count {@code E}: occupancy minus parked entries. A parked run holds
     * a virtual admission slot but is not executing, so drains compare this number
     * against the cap before resuming the queue head.
     */
    int executingCount(String sessionId) {
        int executing = 0;
        for (ChatRun run : chatRuns.findBySessionIdAndStatusIn(
                sessionId, ChatRunCancellationService.NON_TERMINAL_STATUSES)) {
            if (isWaiting(run)) {
                continue;
            }
            if (dispatchQueue.isParked(sessionId, run.getId().toString())) {
                continue;
            }
            executing++;
        }
        return executing;
    }

    /**
     * Resume gate (D-1786 面 B): true when this Run may resume executing now, i.e.
     * the executing count of the Session <b>excluding this Run</b> is below the cap.
     * The resuming Run itself may transiently classify as executing (after its
     * answer CAS it is no longer waiting), so it is excluded from the count. Parked
     * entries never count here — they are not executing.
     */
    boolean canResume(String sessionId, String runId) {
        int otherExecuting = 0;
        for (ChatRun run : chatRuns.findBySessionIdAndStatusIn(
                sessionId, ChatRunCancellationService.NON_TERMINAL_STATUSES)) {
            if (runId.equals(run.getId().toString())) {
                continue;
            }
            if (isWaiting(run)) {
                continue;
            }
            if (dispatchQueue.isParked(sessionId, run.getId().toString())) {
                continue;
            }
            otherExecuting++;
        }
        return otherExecuting < maxConcurrentRuns();
    }

    /**
     * Admission gate. Callers MUST already hold the Session row lock (both
     * {@code ChatSubmissionService.persist} and
     * {@code ChatRunContinuationService.continueRun} do), otherwise the count is
     * only advisory.
     *
     * @throws CpApiException {@code 409 CHAT_IN_PROGRESS} when the Session already
     *                        holds {@code cap} non-waiting Runs (executing or
     *                        parked — parked ones block admission so the queue
     *                        cannot be jumped).
     */
    void requireSlot(String sessionId) {
        int cap = maxConcurrentRuns();
        int occupancy = admissionOccupancy(sessionId);
        if (occupancy >= cap) {
            logger.warn("[LIFECYCLE] service=cp event=chat_session_run_cap_reached "
                    + "sessionId={} occupancy={} cap={}", sessionId, occupancy, cap);
            throw new CpApiException(HttpStatus.CONFLICT, "CHAT_IN_PROGRESS",
                    "Session already has " + occupancy + " in-flight chat run(s); the limit is " + cap);
        }
    }

    /** True when the Session has room for one more in-flight Run. */
    boolean hasSlot(String sessionId) {
        return admissionOccupancy(sessionId) < maxConcurrentRuns();
    }
}
