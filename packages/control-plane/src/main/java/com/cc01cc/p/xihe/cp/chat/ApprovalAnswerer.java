package com.cc01cc.p.xihe.cp.chat;

import com.cc01cc.p.xihe.cp.logging.LogRedactor;

/**
 * PLAN-0328 M1 (spec §3 ⑦ / §12, decisions #22/#34): one pluggable answerer on the approval
 * ask seam.
 *
 * <p>An answerer only ever answers an already-evaluated {@code ask} verdict — it must not
 * participate in the layered policy evaluation that produced the ask, and it must not widen
 * an upstream {@code deny} or hard guard (spec §4.5). Implementations are side-effect free:
 * the chain resolves, the service applies and audits.</p>
 */
public interface ApprovalAnswerer {

    /** Stable identifier recorded by the audit trail as {@code answerer=<id>}. */
    String id();

    /** Answer one ask. Must return a bounded, display-safe reason and never fail open. */
    Answer answer(Ask ask);

    /** One ask: bounded, display-only facts; raw arguments never travel to answerers. */
    record Ask(String sessionId, String tool, String action, String details) {
    }

    /**
     * Chain outcomes: the first {@code ALLOW}/{@code DENY} wins; {@code DEFER} and
     * {@code UNAVAILABLE} fall through to the next answerer (spec §12).
     */
    enum Outcome {
        ALLOW, DENY, DEFER, UNAVAILABLE
    }

    /**
     * One bounded answer. {@code DEFER} means "a later answerer may answer, otherwise the human
     * stays responsible"; {@code UNAVAILABLE} means this answerer cannot answer at all.
     *
     * <p>The reason is redacted and truncated so it is safe to log and audit; it is never a
     * decision input.</p>
     */
    record Answer(Outcome outcome, String reason) {

        private static final int MAX_REASON_LENGTH = 200;

        public Answer {
            if (outcome == null) {
                throw new IllegalArgumentException("outcome is required");
            }
            reason = safeReason(reason);
        }

        public static Answer allow(String reason) {
            return new Answer(Outcome.ALLOW, reason);
        }

        public static Answer deny(String reason) {
            return new Answer(Outcome.DENY, reason);
        }

        public static Answer defer(String reason) {
            return new Answer(Outcome.DEFER, reason);
        }

        public static Answer unavailable(String reason) {
            return new Answer(Outcome.UNAVAILABLE, reason);
        }

        private static String safeReason(String reason) {
            if (reason == null || reason.isBlank()) {
                return null;
            }
            String redacted = LogRedactor.redact(reason.trim());
            return redacted.length() <= MAX_REASON_LENGTH
                    ? redacted : redacted.substring(0, MAX_REASON_LENGTH) + "…";
        }
    }
}
