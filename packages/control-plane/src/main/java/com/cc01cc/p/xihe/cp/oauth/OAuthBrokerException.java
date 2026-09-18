package com.cc01cc.p.xihe.cp.oauth;

/**
 * PLAN-0349: two-tier broker failure classification (decision #12).
 *
 * <p>{@link Kind#REAUTH_REQUIRED} = deterministic, not retryable: missing
 * credential, non-AUTHORIZED status, scope mismatch, or the provider
 * explicitly rejecting the refresh (HTTP 4xx / OAuth error such as
 * {@code invalid_grant}). Mapped to 401 {@code OAUTH_REAUTH_REQUIRED}.
 *
 * <p>{@link Kind#TOKEN_UNAVAILABLE} = transient: provider unreachable,
 * timeout, 5xx, or an unparseable provider response. Mapped to 503
 * {@code OAUTH_TOKEN_UNAVAILABLE}. Row-lock wait timeouts keep their own
 * {@code OPERATION_LOCK_TIMEOUT} mapping (PLAN-0346) and never pass through
 * this type.
 *
 * <p>Messages must stay sanitized: no token material, no provider response
 * bodies, no credential ciphertext.
 */
public class OAuthBrokerException extends RuntimeException {

    public enum Kind {
        REAUTH_REQUIRED,
        TOKEN_UNAVAILABLE
    }

    private final Kind kind;

    public OAuthBrokerException(Kind kind, String message) {
        super(message);
        this.kind = kind;
    }

    public OAuthBrokerException(Kind kind, String message, Throwable cause) {
        super(message, cause);
        this.kind = kind;
    }

    public Kind kind() {
        return kind;
    }
}
