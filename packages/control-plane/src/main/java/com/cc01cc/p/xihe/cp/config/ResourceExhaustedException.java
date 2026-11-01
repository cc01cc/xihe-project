package com.cc01cc.p.xihe.cp.config;

import com.cc01cc.p.xihe.cp.policy.ResourceKey;
import org.springframework.http.HttpStatus;

/**
 * PLAN-0622 M1.5 (design §3.1): the resource governor's refusal.
 *
 * <p>A {@code 429 RESOURCE_EXHAUSTED} is <b>not</b> a {@code 503}: the backend is healthy, the
 * caller is over its configured limit, and the honest answer is "retry after the delay" (checklist
 * R7). The response is rendered by {@code ProblemDetailsHandler} with the {@code Retry-After} and
 * {@code Cache-Control: no-store} headers plus the matching body fields, so the header and
 * {@code retryAfterSeconds} can never drift apart (R6).</p>
 */
public class ResourceExhaustedException extends CpApiException {

    private final int retryAfterSeconds;
    private final ResourceKey key;

    public ResourceExhaustedException(ResourceKey key, int retryAfterSeconds, String detail) {
        super(HttpStatus.TOO_MANY_REQUESTS, "RESOURCE_EXHAUSTED", detail);
        this.retryAfterSeconds = Math.max(1, retryAfterSeconds);
        this.key = key;
    }

    public int getRetryAfterSeconds() {
        return retryAfterSeconds;
    }

    public String getResourceKind() {
        return key == null ? null : key.kind().name();
    }

    public String getScope() {
        return key == null ? null : key.scope();
    }
}
