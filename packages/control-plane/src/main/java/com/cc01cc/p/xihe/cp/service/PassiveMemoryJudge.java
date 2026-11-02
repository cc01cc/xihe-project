package com.cc01cc.p.xihe.cp.service;

import java.util.UUID;

/**
 * PLAN-0629 M1-6 (D29-26): the {@code passive=judge} gate — "is this segment worth remembering?".
 *
 * <p>The passive summary path already has the content (the compaction summary that exists anyway), so
 * the judge is only ever asked a <b>yes/no</b> question about an artifact that was produced for another
 * reason. That keeps the whole feature inside D29-26's rule: no second content-generation call, and the
 * judge reuse is the <i>existing</i> judge seam ({@link JudgeModelClient}, the same transport
 * {@link JudgeDecisionService} uses), not a new judging infrastructure.</p>
 *
 * <p>Fail-closed contract (same discipline as D29-26 "no model ⇒ no write"):</p>
 * <ul>
 *   <li>an unavailable transport, a timeout or an unparseable verdict is reported as
 *       {@link Verdict#available()} = {@code false} and the caller <b>skips</b> the write — it must never
 *       degrade into "write the rule summary anyway", because that would be exactly the silent write
 *       D29-24 rejected;</li>
 *   <li>a parsed verdict that does not explicitly say {@code true} counts as {@code false}.</li>
 * </ul>
 */
public interface PassiveMemoryJudge {

    /**
     * @param principalId the subject whose memory would receive the candidate (for metering/audit only;
     *     the judge never sees the principal's other memories)
     * @param sessionId the session whose compaction produced {@code content}
     * @param content the candidate text (the caller has already bounded it)
     * @return never {@code null}
     */
    Verdict judge(UUID principalId, String sessionId, String content);

    /**
     * @param available whether the judge actually answered; when {@code false} the caller skips
     * @param worthRemembering only meaningful when {@code available}
     * @param reason the machine-readable why (token accounting goes to the caller's log, not here)
     */
    record Verdict(boolean available, boolean worthRemembering, String reason,
                   Long promptTokens, Long completionTokens) {

        public static Verdict answer(boolean worthRemembering, String reason,
                                     Long promptTokens, Long completionTokens) {
            return new Verdict(true, worthRemembering, reason == null ? "" : reason,
                    promptTokens, completionTokens);
        }

        public static Verdict unavailable(String reason) {
            return new Verdict(false, false, reason, null, null);
        }
    }
}
