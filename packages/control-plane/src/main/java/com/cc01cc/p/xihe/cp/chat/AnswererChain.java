package com.cc01cc.p.xihe.cp.chat;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import java.util.List;

/**
 * PLAN-0328 M1 (spec §3 ⑦/⑧, §12, decisions #18/#22): the pluggable answerer chain for one
 * {@code ask} verdict.
 *
 * <p>Answerers are consulted in order ({@code user} → {@code auto_review}, spec §3):
 * {@code DEFER} and {@code UNAVAILABLE} fall through to the next answerer, and the first
 * {@code ALLOW}/{@code DENY} wins. An answerer that throws or returns nothing is treated as
 * {@code UNAVAILABLE} with a safe lifecycle log — an answerer failure can never become an
 * allow. When no answerer can answer (all-UNAVAILABLE, or an empty chain) the chain reports
 * {@link #ANSWERER_NONE}: the caller owns the fail-closed reject so that a pending row nobody
 * can answer is never persisted (spec §3 ⑧ "无可用回答者 → deny").</p>
 */
@Component
public class AnswererChain {

    private static final Logger logger = LoggerFactory.getLogger(AnswererChain.class);

    /** Audit id used when no answerer produced an answer. */
    public static final String ANSWERER_NONE = "none";

    private final List<ApprovalAnswerer> answerers;

    public AnswererChain(List<ApprovalAnswerer> answerers) {
        this.answerers = List.copyOf(answerers);
    }

    /** One chain result: which answerer answered, the effective outcome and its safe reason. */
    public record Resolution(String answerer, ApprovalAnswerer.Outcome outcome, String reason) {
    }

    /** Resolve one ask in order, with per-answerer failure isolation. */
    public Resolution resolve(ApprovalAnswerer.Ask ask) {
        ApprovalAnswerer.Answer deferred = null;
        String deferredBy = null;
        for (ApprovalAnswerer answerer : answerers) {
            ApprovalAnswerer.Answer answer = safeAnswer(answerer, ask);
            ApprovalAnswerer.Outcome outcome = answer.outcome();
            if (outcome == ApprovalAnswerer.Outcome.ALLOW
                    || outcome == ApprovalAnswerer.Outcome.DENY) {
                return new Resolution(answererId(answerer), outcome, answer.reason());
            }
            if (outcome == ApprovalAnswerer.Outcome.DEFER && deferred == null) {
                deferred = answer;
                deferredBy = answererId(answerer);
            }
        }
        if (deferred != null) {
            return new Resolution(deferredBy, deferred.outcome(), deferred.reason());
        }
        return new Resolution(ANSWERER_NONE, ApprovalAnswerer.Outcome.UNAVAILABLE,
                "no answerer is available");
    }

    private ApprovalAnswerer.Answer safeAnswer(ApprovalAnswerer answerer, ApprovalAnswerer.Ask ask) {
        try {
            ApprovalAnswerer.Answer answer = answerer.answer(ask);
            if (answer == null) {
                logger.warn("[LIFECYCLE] service=cp event=approval_answerer_misbehaved"
                        + " answerer={} reason=null_answer", answererId(answerer));
                return ApprovalAnswerer.Answer.unavailable("answerer returned no answer");
            }
            return answer;
        } catch (RuntimeException e) {
            logger.warn("[LIFECYCLE] service=cp event=approval_answerer_failed answerer={} failureType={}",
                    answererId(answerer), e.getClass().getName());
            return ApprovalAnswerer.Answer.unavailable("answerer failed");
        }
    }

    private static String answererId(ApprovalAnswerer answerer) {
        try {
            String id = answerer.id();
            return id == null || id.isBlank() ? "unknown" : id;
        } catch (RuntimeException e) {
            return "unknown";
        }
    }
}
