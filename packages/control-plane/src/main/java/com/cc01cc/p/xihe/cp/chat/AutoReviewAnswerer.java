package com.cc01cc.p.xihe.cp.chat;

import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;

/**
 * PLAN-0328 M1 (spec §12, decision #22): the deferred auto-review answerer.
 *
 * <p>The scope tier is the constant {@link Tier#OFF} in this batch: no LLM call, no config
 * lookup, no Runtime/sandbox access. OFF always answers {@code UNAVAILABLE}, so the chain
 * falls through to the human and this answerer can never auto-allow. A future sync/adaptive
 * tier must keep the same fail-closed contract — a failed review falls back to the human
 * path, never to a silent allow.</p>
 */
@Component
@Order(20)
public class AutoReviewAnswerer implements ApprovalAnswerer {

    /** Audit id and chain position identifier of the auto-review answerer. */
    public static final String ID = "auto_review";

    /** Scope tier of the auto-review answerer (spec §12: 关/同步/自适应). */
    public enum Tier {
        OFF
    }

    /** Tier constant of this batch; turning it on is a later batch with its own review path. */
    public static final Tier TIER = Tier.OFF;

    @Override
    public String id() {
        return ID;
    }

    @Override
    public Answer answer(Ask ask) {
        return Answer.unavailable("auto_review tier is off");
    }
}
