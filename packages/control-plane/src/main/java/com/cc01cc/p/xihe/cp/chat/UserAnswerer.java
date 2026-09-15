package com.cc01cc.p.xihe.cp.chat;

import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;

/**
 * PLAN-0328 M1 (spec §12): the human answerer. The UI submits the real decision through the
 * existing decision API, so the chain only ever sees {@code DEFER} — this answerer can never
 * auto-allow or auto-deny a request.
 *
 * <p>Whether a live UI is actually reachable is a later tier concern; until then the human
 * path stays deferred and the request remains answerable.</p>
 */
@Component
@Order(10)
public class UserAnswerer implements ApprovalAnswerer {

    /** Audit id and chain position identifier of the human answerer. */
    public static final String ID = "user";

    @Override
    public String id() {
        return ID;
    }

    @Override
    public Answer answer(Ask ask) {
        return Answer.defer("user decision required");
    }
}
