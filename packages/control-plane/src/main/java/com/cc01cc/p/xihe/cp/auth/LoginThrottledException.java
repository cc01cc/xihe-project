package com.cc01cc.p.xihe.cp.auth;

import org.springframework.http.HttpStatus;
import com.cc01cc.p.xihe.cp.config.CpApiException;

/**
 * PLAN-0558: a 429 with the retry delay the caller must put in Retry-After.
 * The reason (account, IP, concurrency) stays internal.
 */
public class LoginThrottledException extends CpApiException {

    private final int retryAfterSeconds;

    public LoginThrottledException(int retryAfterSeconds) {
        super(HttpStatus.TOO_MANY_REQUESTS, "AUTH_RATE_LIMITED",
                "Too many login attempts; retry later");
        this.retryAfterSeconds = Math.max(1, retryAfterSeconds);
    }

    public int getRetryAfterSeconds() {
        return retryAfterSeconds;
    }
}
