package com.cc01cc.p.xihe.cp.service;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * PLAN-0624 M1 boundary: the judge transport is wired to the Agent-side
 * {@code /internal/v1/agent/judge/decide} endpoint together with the Q6 real-model evidence
 * (the decision-model-preview account authorization is a user-side action). Until that wiring
 * lands, this fail-closed stub was the only {@link JudgeModelClient} bean: every call reports
 * FAILED, so every JUDGE branch answers "do not speak" and audits the refusal (Q2).
 *
 * <p><b>Deletion contract (PLAN-0690 T1.2b CP-1):</b> the Agent-backed
 * {@link AgentJudgeModelClient} has landed, so this class is <b>no longer a bean</b> — the
 * interface was designed as the seam, and two coexisting beans must never happen. The class body
 * is kept only because removing files needs a separate approval; a later cleanup commit should
 * delete it together with this Javadoc.</p>
 */
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
