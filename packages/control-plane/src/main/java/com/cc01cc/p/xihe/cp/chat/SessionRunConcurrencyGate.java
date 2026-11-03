package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.config.ConfigService;
import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.repository.ChatRunRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Component;

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
 * <p>The cap is {@code agent-runtime.maxConcurrentRunsPerSession} (instance-only,
 * default 2, range 1–4). {@code cap=1} reproduces the frozen single-flight
 * behaviour exactly, which is why the rollback is one config write and not a code
 * switch. Unreadable/invalid values fall back to the default with a warning: this
 * is a resource-admission valve, not a security boundary, so a misconfigured value
 * must not fail every chat.</p>
 */
@Component
public class SessionRunConcurrencyGate {

    static final int DEFAULT_MAX_CONCURRENT_RUNS = 2;
    static final int MAX_CONCURRENT_RUNS_CEILING = 4;
    static final String CONFIG_DOMAIN = "agent-runtime";
    static final String CONFIG_KEY = "maxConcurrentRunsPerSession";

    private static final Logger logger = LoggerFactory.getLogger(SessionRunConcurrencyGate.class);

    private final ChatRunRepository chatRuns;
    private final ConfigService configService;

    public SessionRunConcurrencyGate(ChatRunRepository chatRuns, ConfigService configService) {
        this.chatRuns = chatRuns;
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

    int inFlightRuns(String sessionId) {
        return (int) chatRuns.countBySessionIdAndStatusIn(
                sessionId, ChatRunCancellationService.NON_TERMINAL_STATUSES);
    }

    /**
     * Admission gate. Callers MUST already hold the Session row lock (both
     * {@code ChatSubmissionService.persist} and
     * {@code ChatRunContinuationService.continueRun} do), otherwise the count is
     * only advisory.
     *
     * @throws CpApiException {@code 409 CHAT_IN_PROGRESS} when the Session already
     *                        holds {@code cap} non-terminal Runs.
     */
    void requireSlot(String sessionId) {
        int cap = maxConcurrentRuns();
        int inFlight = inFlightRuns(sessionId);
        if (inFlight >= cap) {
            logger.warn("[LIFECYCLE] service=cp event=chat_session_run_cap_reached "
                    + "sessionId={} inFlight={} cap={}", sessionId, inFlight, cap);
            throw new CpApiException(HttpStatus.CONFLICT, "CHAT_IN_PROGRESS",
                    "Session already has " + inFlight + " in-flight chat run(s); the limit is " + cap);
        }
    }

    /** True when the Session has room for one more in-flight Run. */
    boolean hasSlot(String sessionId) {
        return inFlightRuns(sessionId) < maxConcurrentRuns();
    }
}
