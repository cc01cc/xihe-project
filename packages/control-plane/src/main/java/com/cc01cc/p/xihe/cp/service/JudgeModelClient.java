package com.cc01cc.p.xihe.cp.service;

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

    /** What the judge needs: the model identity and the fully assembled prompt (Q1 window). */
    record JudgeRequest(String modelProvider, String modelName, String prompt) {}

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
