package com.cc01cc.p.xihe.cp.service;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

/**
 * PLAN-0624 M1 boundary: the judge transport is wired to the Agent-side
 * {@code /internal/v1/agent/judge/decide} endpoint together with the Q6 real-model evidence
 * (the decision-model-preview account authorization is a user-side action). Until that wiring
 * lands, this fail-closed stub is the only {@link JudgeModelClient} bean: every call reports
 * FAILED, so every JUDGE branch answers "do not speak" and audits the refusal (Q2).
 *
 * <p><b>Deletion contract:</b> when the Agent-backed client appears, delete this class — the
 * interface was designed as the seam, and two coexisting beans must never happen.</p>
 */
@Component
public class JudgeModelClientUnavailableStub implements JudgeModelClient {

    private static final Logger logger = LoggerFactory.getLogger(JudgeModelClientUnavailableStub.class);

    @Override
    public JudgeVerdict decide(JudgeRequest request) throws JudgeException {
        logger.warn("[LIFECYCLE] service=cp event=judge_client_unwired model={}/{} "
                + "(Q6 wiring pending; fail-closed per PLAN-0624 Q2)",
                request.modelProvider(), request.modelName());
        throw new JudgeException(JudgeException.Kind.FAILED,
                "judge model client is not wired yet (Q6 real-model evidence pending)");
    }
}
