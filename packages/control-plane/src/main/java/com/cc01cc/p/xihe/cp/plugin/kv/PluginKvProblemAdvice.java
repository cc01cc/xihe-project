package com.cc01cc.p.xihe.cp.plugin.kv;

import com.cc01cc.p.xihe.cp.config.ProblemDetailsHandler;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * PLAN-0691 T1.5: renders {@code 429 PLUGIN_RATE_LIMITED} with a {@code Retry-After} header
 * (spec/data-plane.md QUOTA-4; verify.md V5 asserts the header, not just the status).
 *
 * <p>Why a local advice instead of the shared handler: {@code ProblemDetailsHandler} carries the
 * header channel only for the resource-governor's {@code RESOURCE_EXHAUSTED} path, and that code is
 * frozen to six {@code ResourceKey.Kind} values without a {@code RATE} kind
 * ({@code cp/policy/ResourceKey.java}). Widening that enum to borrow its 429 would put a plugin-only
 * concern into the governor's vocabulary; adding a second header branch to the shared handler would
 * touch a file every other 4xx flows through. So the plugin KV surface owns its own 429 rendering and
 * reuses the shared {@code problemResponse} helper for the body shape (type/title/status/code/detail/
 * requestId), keeping one Problem Details implementation.
 *
 * <p>{@code HIGHEST_PRECEDENCE} only affects exception-type resolution; this advice declares a single
 * exception type, so no other handler's routing changes.
 */
@RestControllerAdvice
@Order(Ordered.HIGHEST_PRECEDENCE)
public class PluginKvProblemAdvice {

    private static final Logger logger = LoggerFactory.getLogger(PluginKvProblemAdvice.class);

    @ExceptionHandler(PluginKvRateLimitedException.class)
    public ResponseEntity<Map<String, Object>> rateLimited(PluginKvRateLimitedException exception) {
        logger.warn("[PLUGIN] event=plugin_kv_rate_limited retryAfter={}s detail={}",
                exception.retryAfterSeconds(), exception.getMessage());
        Map<String, String> headers = new LinkedHashMap<>();
        headers.put("Retry-After", Long.toString(exception.retryAfterSeconds()));
        headers.put("Cache-Control", "no-store");
        Map<String, Object> extra = new LinkedHashMap<>();
        extra.put("retryAfterSeconds", exception.retryAfterSeconds());
        return ProblemDetailsHandler.problemResponse(HttpStatus.TOO_MANY_REQUESTS, "PLUGIN_RATE_LIMITED",
                exception.getMessage(), headers, extra);
    }
}
