package com.cc01cc.p.xihe.cp.plugin.kv;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import org.springframework.http.HttpStatus;

/**
 * PLAN-0691 T1.5: a per-binding rate/concurrency refusal on the KV data plane
 * (spec/data-plane.md QUOTA-4/QUOTA-5, code {@code PLUGIN_RATE_LIMITED}, 429).
 *
 * <p>It extends {@link CpApiException} so that the shared handler already renders a correct
 * {@code 429 PLUGIN_RATE_LIMITED} problem document even if the local advice is not applied; the
 * advice exists only to add the {@code Retry-After} header that V5 asserts (the shared
 * {@code IllegalArgumentException} path has no header channel).
 */
public class PluginKvRateLimitedException extends CpApiException {

    private final long retryAfterSeconds;

    PluginKvRateLimitedException(long retryAfterSeconds, String detail) {
        super(HttpStatus.TOO_MANY_REQUESTS, "PLUGIN_RATE_LIMITED", detail);
        this.retryAfterSeconds = retryAfterSeconds;
    }

    /** Seconds the caller should wait before retrying; always at least 1. */
    public long retryAfterSeconds() {
        return retryAfterSeconds;
    }
}
