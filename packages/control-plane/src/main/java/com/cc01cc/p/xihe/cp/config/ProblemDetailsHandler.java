package com.cc01cc.p.xihe.cp.config;

import jakarta.servlet.http.HttpServletRequest;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.dao.CannotAcquireLockException;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.dao.PessimisticLockingFailureException;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.context.request.async.AsyncRequestNotUsableException;
import org.springframework.security.access.AccessDeniedException;
import org.springframework.web.bind.MethodArgumentNotValidException;
import org.springframework.web.HttpMediaTypeNotAcceptableException;
import org.springframework.web.HttpMediaTypeNotSupportedException;
import org.springframework.web.HttpRequestMethodNotSupportedException;
import org.springframework.web.bind.MissingPathVariableException;
import org.springframework.web.bind.MissingServletRequestParameterException;
import org.springframework.web.method.annotation.MethodArgumentTypeMismatchException;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.web.servlet.resource.NoResourceFoundException;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

@RestControllerAdvice
public class ProblemDetailsHandler {
    private static final Logger logger = LoggerFactory.getLogger(ProblemDetailsHandler.class);
    private final long lockTimeoutMs;

    public ProblemDetailsHandler(@Value("${cp.lock-timeout-ms:5000}") long lockTimeoutMs) {
        this.lockTimeoutMs = lockTimeoutMs;
    }

    /**
     * PLAN-0614 design ("workspaceId may be null; without a context still 400/409"): a missing
     * <b>workspace context</b> is a conflict with the account's current state, not an authentication
     * failure. The caller <i>is</i> authenticated — it simply has no active workspace yet (blank
     * start) or has more than one and named none. Returning 401 here made the UI's auth interceptor
     * treat it as "not logged in" and force a logout (BL-181).
     *
     * <p>Uses the pre-existing {@code WORKSPACE_CONTEXT_REQUIRED} code that
     * {@code SessionCreationService} already answers for "multiple workspaces, none specified", so
     * one semantic keeps one status/code pair. Genuine authentication failures stay 401 and are
     * produced by the security filter chain / token authenticator, never here.</p>
     */
    /**
     * PLAN-0615 (BL-182): a context guard found no authenticated principal.
     *
     * <p>{@code @PreAuthorize} guarantees a principal, so this branch is an <b>invariant fuse</b>, not
     * a reachable state. It answers {@code 403 FORBIDDEN} (the existing code) rather than 401: the
     * request is authenticated, and clients read 401 as session expiry and force a logout. The warn
     * line is the point — a tripped fuse must leave a trace (requestId + path).</p>
     */
    public static ResponseEntity<Map<String, Object>> missingPrincipal(String detail) {
        warnMissingPrincipal(detail);
        return problemResponse(HttpStatus.FORBIDDEN, "FORBIDDEN", detail);
    }

    /** Service-layer twin of {@link #missingPrincipal(String)}. */
    public static CpApiException missingPrincipalException(String detail) {
        warnMissingPrincipal(detail);
        return new CpApiException(HttpStatus.FORBIDDEN, "FORBIDDEN", detail);
    }

    private static void warnMissingPrincipal(String detail) {
        String requestId = org.slf4j.MDC.get(com.cc01cc.p.xihe.cp.logging.RequestIdFilter.MDC_KEY);
        String path = currentRequestPath();
        logger.warn("[AUTH] event=context_guard_without_principal status=403 detail={} path={} requestId={}",
                detail, path, requestId);
    }

    private static String currentRequestPath() {
        try {
            org.springframework.web.context.request.RequestAttributes attributes =
                    org.springframework.web.context.request.RequestContextHolder.getRequestAttributes();
            if (attributes instanceof org.springframework.web.context.request.ServletRequestAttributes servlet) {
                return servlet.getRequest().getRequestURI();
            }
        } catch (RuntimeException unavailable) {
            // No request scope (unit tests / async): the warn line still carries detail + requestId.
            logger.debug("request path unavailable for missing-principal warn: {}", unavailable.getMessage());
        }
        return null;
    }

    public static ResponseEntity<Map<String, Object>> workspaceContextRequired() {
        return problemResponse(HttpStatus.CONFLICT, "WORKSPACE_CONTEXT_REQUIRED",
                "Workspace context is required");
    }

    public static ResponseEntity<Map<String, Object>> problemResponse(HttpStatus status, String code, String detail) {
        return problemResponse(status, code, detail,
                org.slf4j.MDC.get(com.cc01cc.p.xihe.cp.logging.RequestIdFilter.MDC_KEY));
    }

    public static ResponseEntity<Map<String, Object>> problemResponse(
            HttpStatus status, String code, String detail, String requestId) {
        if (requestId == null || requestId.isBlank()) {
            requestId = UUID.randomUUID().toString();
        }
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("type", "https://xihe.dev/problems/" + code.toLowerCase());
        body.put("title", status.getReasonPhrase());
        body.put("status", status.value());
        body.put("code", code);
        body.put("detail", detail);
        body.put("requestId", requestId);
        return ResponseEntity.status(status).contentType(MediaType.parseMediaType("application/problem+json"))
                .header("X-Request-Id", requestId).body(body);
    }

    /**
     * Problem response with additional contract fields (for example the conflict
     * paths or head-fingerprint triple of a rejected revert). Values must be
     * JSON-serializable plain types.
     */
    public static ResponseEntity<Map<String, Object>> problemResponse(
            HttpStatus status, String code, String detail, Map<String, Object> extra) {
        ResponseEntity<Map<String, Object>> response = problemResponse(status, code, detail);
        Map<String, Object> body = response.getBody();
        if (body != null && extra != null && !extra.isEmpty()) {
            body.putAll(extra);
        }
        return response;
    }

    /**
     * PLAN-0558: same Problem Details shape plus explicit response headers
     * (for example {@code Retry-After} and {@code Cache-Control} on 429).
     */
    public static ResponseEntity<Map<String, Object>> problemResponse(
            HttpStatus status, String code, String detail,
            Map<String, String> headers, Map<String, Object> extra) {
        ResponseEntity<Map<String, Object>> base = problemResponse(status, code, detail);
        Map<String, Object> body = base.getBody();
        if (body != null && extra != null && !extra.isEmpty()) {
            body.putAll(extra);
        }
        ResponseEntity.BodyBuilder builder = ResponseEntity.status(status)
                .contentType(MediaType.parseMediaType("application/problem+json"));
        String requestId = base.getHeaders().getFirst("X-Request-Id");
        if (requestId != null) {
            builder.header("X-Request-Id", requestId);
        }
        if (headers != null) {
            headers.forEach((name, value) -> builder.header(name, value));
        }
        return builder.body(body);
    }

    /**
     * PLAN-0621 F-06（M3）：**框架级 4xx 必须显式映射**。
     *
     * <p>有头走查实测：对只支持 POST 的集合端点发 {@code GET /api/v1/workspaces/{id}/sessions} 得到
     * {@code 500 INTERNAL_ERROR "Request failed"}。根因不是那条路由，而是本类末尾的
     * {@code @ExceptionHandler(Exception.class)} 兜底：Spring MVC 在进入 controller 之前抛出的
     * {@code HttpRequestMethodNotSupportedException} / {@code HttpMediaTypeNotSupportedException}
     * 等没有更具体的处理器，就全部落进 500。</p>
     *
     * <p>这些异常**本身就是客户端错误**（405/415/406/400），显式映射回各自的 4xx：调用方能拿到可行动的
     * code，监控里的 500 也只剩真正的服务端故障。<b>不动 {@code Exception} 兜底</b>——它仍需捕获真正
     * 未预期的异常。</p>
     */
    @ExceptionHandler({HttpRequestMethodNotSupportedException.class,
            HttpMediaTypeNotSupportedException.class,
            HttpMediaTypeNotAcceptableException.class,
            MethodArgumentTypeMismatchException.class,
            MissingServletRequestParameterException.class,
            MissingPathVariableException.class})
    public ResponseEntity<Map<String, Object>> frameworkClientError(Exception exception, HttpServletRequest request) {
        HttpStatus status;
        String code;
        String detail;
        if (exception instanceof HttpRequestMethodNotSupportedException methodNotSupported) {
            status = HttpStatus.METHOD_NOT_ALLOWED;
            code = "METHOD_NOT_ALLOWED";
            detail = "HTTP method " + String.valueOf(methodNotSupported.getMethod())
                    + " is not supported for this resource";
        } else if (exception instanceof HttpMediaTypeNotSupportedException mediaTypeNotSupported) {
            status = HttpStatus.UNSUPPORTED_MEDIA_TYPE;
            code = "UNSUPPORTED_MEDIA_TYPE";
            detail = "Content type " + String.valueOf(mediaTypeNotSupported.getContentType())
                    + " is not supported for this resource";
        } else if (exception instanceof HttpMediaTypeNotAcceptableException) {
            status = HttpStatus.NOT_ACCEPTABLE;
            code = "NOT_ACCEPTABLE";
            detail = "The requested response media type is not available";
        } else {
            // 参数类型不匹配 / 缺查询参数 / 缺路径变量：都是调用方把请求写错了。
            status = HttpStatus.BAD_REQUEST;
            code = "INVALID_REQUEST";
            detail = "Request parameters are invalid";
        }
        logger.warn("Framework-level client error at {}: {} ({} {})", request.getRequestURI(),
                exception.getClass().getSimpleName(), status.value(), code);
        return problem(status, code, detail, request);
    }

    /**
     * PLAN-0622 M1.5 (R6/R7): a resource-governor refusal is a {@code 429 RESOURCE_EXHAUSTED} whose
     * retry hint is carried on <b>both</b> channels — the {@code Retry-After} header and
     * {@code retryAfterSeconds} in the body always hold the same value — together with
     * {@code resourceKind}/{@code scope} for diagnosis. It is never a 503: the dependency is
     * healthy, the caller is over its configured limit.
     */
    @ExceptionHandler(ResourceExhaustedException.class)
    public ResponseEntity<Map<String, Object>> resourceExhausted(ResourceExhaustedException exception,
                                                                HttpServletRequest request) {
        logger.warn("Resource exhausted at {}: kind={} scope={} retryAfter={}s", request.getRequestURI(),
                exception.getResourceKind(), exception.getScope(), exception.getRetryAfterSeconds());
        Map<String, String> headers = new LinkedHashMap<>();
        headers.put("Retry-After", Integer.toString(exception.getRetryAfterSeconds()));
        headers.put("Cache-Control", "no-store");
        Map<String, Object> extra = new LinkedHashMap<>();
        extra.put("retryAfterSeconds", exception.getRetryAfterSeconds());
        extra.put("resourceKind", exception.getResourceKind());
        extra.put("scope", exception.getScope());
        return problemResponse(HttpStatus.TOO_MANY_REQUESTS, "RESOURCE_EXHAUSTED",
                exception.getMessage(), headers, extra);
    }

    @ExceptionHandler({IllegalArgumentException.class, HttpMessageNotReadableException.class,
            MethodArgumentNotValidException.class})
    public ResponseEntity<Map<String, Object>> badRequest(Exception exception, HttpServletRequest request) {
        if (exception instanceof CpApiException apiException) {
            logger.warn("Domain failure at {}: {}", request.getRequestURI(), apiException.getMessage());
            ResponseEntity<Map<String, Object>> response = apiException.getRequestId() == null
                    ? problem(apiException.getStatus(), apiException.getCode(), apiException.getMessage(), request)
                    : problem(apiException.getStatus(), apiException.getCode(), apiException.getMessage(),
                    apiException.getRequestId());
            // PLAN-0670 M2c/B: faces that must throw (streaming return type) still publish their
            // machine-readable extra fields (e.g. export messages/limit) through the same body.
            if (!apiException.getExtra().isEmpty() && response.getBody() != null) {
                response.getBody().putAll(apiException.getExtra());
            }
            return response;
        }
        logger.warn("Bad request at {}", request.getRequestURI(), exception);
        return problem(HttpStatus.BAD_REQUEST, "INVALID_REQUEST", "Request validation failed", request);
    }

    /**
     * PLAN-0610 W3-2a (round-4 handoff): a database-side serialization failure or deadlock
     * ({@code 40001}/{@code 40P01}) is a <b>retryable conflict</b>, not a server error. PostgreSQL
     * aborts one of the transactions; the API answers {@code 409 CONCURRENT_MODIFICATION} so the
     * client can retry instead of seeing a 500.
     *
     * <p>Registered on {@link PessimisticLockingFailureException} because Spring maps both
     * SQLSTATEs onto it ({@code DeadlockLoserDataAccessException} /
     * {@code PessimisticLockingFailureException}); a lock <em>timeout</em> (55P03) arrives as the
     * more specific {@link CannotAcquireLockException} and keeps its 503 semantics.</p>
     */
    @ExceptionHandler(PessimisticLockingFailureException.class)
    public ResponseEntity<Map<String, Object>> concurrentModification(
            PessimisticLockingFailureException exception, HttpServletRequest request) {
        String requestId = resolveRequestId(request);
        Throwable cause = exception.getMostSpecificCause();
        logger.warn("[LIFECYCLE] service=cp event=concurrent_modification path={} requestId={} reason={}",
                request.getRequestURI(), requestId,
                cause == null ? exception.getMessage() : cause.getMessage());
        return problem(HttpStatus.CONFLICT, "CONCURRENT_MODIFICATION",
                "Concurrent modification detected; retry the request", requestId);
    }

    @ExceptionHandler(CannotAcquireLockException.class)
    public ResponseEntity<Map<String, Object>> lockTimeout(CannotAcquireLockException exception,
                                                           HttpServletRequest request) {
        // PLAN-0346 T1.8: the PostgreSQL lock wait exceeded cp.lock-timeout-ms
        // (SQLSTATE 55P03). The request fails explicitly and is safe to retry;
        // best-effort mirror writers catch this upstream and log a warning.
        String requestId = resolveRequestId(request);
        Throwable cause = exception.getMostSpecificCause();
        logger.warn("[LIFECYCLE] service=cp event=operation_lock_timeout path={} requestId={} timeoutMs={} reason={}",
                request.getRequestURI(), requestId, lockTimeoutMs,
                cause == null ? exception.getMessage() : cause.getMessage());
        return problem(HttpStatus.SERVICE_UNAVAILABLE, "OPERATION_LOCK_TIMEOUT",
                "Database lock wait timed out; the request is safe to retry", requestId);
    }

    @ExceptionHandler(AccessDeniedException.class)
    public ResponseEntity<Map<String, Object>> forbidden(AccessDeniedException exception, HttpServletRequest request) {
        logger.warn("Forbidden request at {}: {}", request.getRequestURI(), exception);
        return problem(HttpStatus.FORBIDDEN, "FORBIDDEN", "Access denied", request);
    }

    @ExceptionHandler(DataIntegrityViolationException.class)
    public ResponseEntity<Map<String, Object>> integrityViolation(
            DataIntegrityViolationException exception, HttpServletRequest request) {
        for (Throwable cause = exception; cause != null; cause = cause.getCause()) {
            if (cause instanceof org.hibernate.exception.ConstraintViolationException constraint) {
                String constraintName = constraint.getConstraintName();
                if ("uq_provider_connections_owner_provider_key".equals(constraintName)) {
                    logger.warn("Provider connection key conflict at {}", request.getRequestURI());
                    return problem(HttpStatus.CONFLICT, "PROVIDER_CONNECTION_KEY_CONFLICT",
                            "A connection already exists for this provider, key and scope", request);
                }
                // PLAN-0555: the label index is a second, independent uniqueness
                // rule; without this branch a concurrent conflict degrades to 500.
                if ("uq_provider_connections_owner_provider_label".equals(constraintName)) {
                    logger.warn("Provider connection label conflict at {}", request.getRequestURI());
                    ResponseEntity<Map<String, Object>> response = problem(
                            HttpStatus.CONFLICT, "PROVIDER_CONNECTION_LABEL_CONFLICT",
                            "A connection with this label already exists for this provider and scope",
                            request);
                    Map<String, Object> body = response.getBody();
                    if (body != null) {
                        body.put("field", "label");
                    }
                    return response;
                }
            }
        }
        logger.error("Unhandled database integrity failure at {}", request.getRequestURI(), exception);
        return problem(HttpStatus.INTERNAL_SERVER_ERROR, "INTERNAL_ERROR", "Request failed", request);
    }

    @ExceptionHandler(NoResourceFoundException.class)
    public ResponseEntity<Map<String, Object>> notFound(NoResourceFoundException exception, HttpServletRequest request) {
        logger.debug("Unmapped path at {}", request.getRequestURI());
        return problem(HttpStatus.NOT_FOUND, "NOT_FOUND", "Resource not found", request);
    }

    @ExceptionHandler(Exception.class)
    public ResponseEntity<?> internalError(Exception exception, HttpServletRequest request) {
        if (exception instanceof AsyncRequestNotUsableException) {
            // A client closing a persistent SSE stream is an expected lifecycle event.
            logger.debug("Async client disconnected at {}: {}", request.getRequestURI(), exception.getMessage());
            return null;
        }
        logger.error("Unhandled request failure at {}", request.getRequestURI(), exception);
        return problem(HttpStatus.INTERNAL_SERVER_ERROR, "INTERNAL_ERROR", "Request failed", request);
    }

    private ResponseEntity<Map<String, Object>> problem(
            HttpStatus status, String code, String detail, HttpServletRequest request) {
        return problem(status, code, detail, resolveRequestId(request));
    }

    private ResponseEntity<Map<String, Object>> problem(
            HttpStatus status, String code, String detail, String requestId) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("type", "https://xihe.dev/problems/" + code.toLowerCase());
        body.put("title", status.getReasonPhrase());
        body.put("status", status.value());
        body.put("code", code);
        body.put("detail", detail == null || detail.isBlank() ? status.getReasonPhrase() : detail);
        body.put("requestId", requestId);
        return ResponseEntity.status(status)
                .contentType(MediaType.parseMediaType("application/problem+json"))
                .header("X-Request-Id", requestId)
                .body(body);
    }

    private static String resolveRequestId(HttpServletRequest request) {
        String requestId = request.getHeader("X-Request-Id");
        if (requestId == null || requestId.isBlank()) {
            requestId = UUID.randomUUID().toString();
        }
        return requestId;
    }
}
