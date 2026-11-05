package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.entity.ChatRun;
import org.slf4j.Logger;

/**
 * BL-354 (P2, follows the BL-347 audit): make a NULL {@code agent_principal_id} on a <b>derived</b>
 * run visible without changing behaviour.
 *
 * <p>Why log-only, not fail: a continuation child of a human-responder {@code user_submission} run
 * inherits NULL <b>by existing, accepted semantics</b> ({@code ChatSubmissionService#create} clears
 * the stamp for a HUMAN responder; {@code ChatRunContinuationService} copies the source stamp). A hard
 * failure here would immediately redden existing continuation tests and mix "pre-existing degraded
 * behaviour" with "new gap". The agreed order is: make it visible first, make it unacceptable later
 * (after the continuation principal semantics are decided).</p>
 *
 * <p>Derived origins at the time of writing: {@code spawn} (covers the human delegation route too — it
 * has no separate origin) and {@code scheduled}, plus any run carrying {@code continuationSourceRunId}
 * (continuation children keep {@code origin=user_submission}). A main submission answered by a HUMAN
 * is deliberately NULL and is <b>not</b> derived — it must not be logged here.</p>
 */
final class RunPrincipalStampDiagnostics {

    static final String EVENT = "run_principal_stamp";

    private RunPrincipalStampDiagnostics() {
    }

    static boolean isDerived(ChatRun run) {
        return run != null
                && (ChatRun.ORIGIN_SPAWN.equals(run.getOrigin())
                || ChatRun.ORIGIN_SCHEDULED.equals(run.getOrigin())
                || run.getContinuationSourceRunId() != null);
    }

    static void logIfDerivedNull(Logger logger, ChatRun run) {
        if (!isDerived(run) || run.getAgentPrincipalId() != null) {
            return;
        }
        logger.warn("[LIFECYCLE] service=cp event={} origin={} runId={} sessionId={} sourceRunId={}"
                        + " reason=derived_principal_null", EVENT, run.getOrigin(), run.getId(),
                run.getSessionId(), run.getContinuationSourceRunId());
    }
}
