package com.cc01cc.p.xihe.cp.service;

import java.util.UUID;

/**
 * PLAN-0624 M1 (D24-01, path A): the transport seam between CP's judge assembly and the model.
 *
 * <p>The interface is deliberately provider-agnostic: the concrete caller is the Agent-side
 * internal endpoint {@code POST /internal/v1/agent/judge/decide} (embedding-test precedent), and
 * the Q6 probe decides whether the model behind it speaks the OpenAI-compatible shape or a
 * dedicated decision API. Neither shape leaks into this seam.</p>
 *
 * <p>Failure contract (PLAN-0624 Q2, fail-closed): any transport/HTTP/timeout problem is reported
 * as a {@link JudgeException} — the service records it and returns "do not speak". A judge that
 * cannot answer never produces a synthetic verdict.</p>
 */
public interface JudgeModelClient {

    /** One judge invocation. Never returns null; throws {@link JudgeException} on any failure. */
    JudgeVerdict decide(JudgeRequest request) throws JudgeException;

    /**
     * What the judge needs: the model identity, the fully assembled prompt (Q1 window) and the
     * owner context needed to issue a short-lived credential lease (PLAN-0690 T1.2b CP-1).
     *
     * <p>{@code sessionId}/{@code runId} are null at the two legacy seams that have no owner
     * context ({@code JudgeSeamPassiveMemoryJudge}, {@code GuardHookAdvisor}): the real client
     * then fails closed per spec §2 instead of borrowing another session's credential.</p>
     */
    record JudgeRequest(String modelProvider, String modelName, String prompt,
                        UUID sessionId, UUID runId) {

        /** Legacy seams without owner context — the call fails closed (spec §2). */
        JudgeRequest(String modelProvider, String modelName, String prompt) {
            this(modelProvider, modelName, prompt, null, null);
        }
    }

    /** What the judge returned: the raw verdict text plus the metered facts (G-04/Q6). */
    record JudgeVerdict(String verdictText, long promptTokens, long completionTokens, long latencyMs) {}

    /** Transport failure. {@link Kind#TIMEOUT} is reported separately so the audit shows it. */
    final class JudgeException extends Exception {

        public enum Kind { FAILED, TIMEOUT }

        private final Kind kind;

        public JudgeException(Kind kind, String message) {
            super(message);
            this.kind = kind;
        }

        public JudgeException(Kind kind, String message, Throwable cause) {
            super(message, cause);
            this.kind = kind;
        }

        public Kind kind() {
            return kind;
        }
    }
}
