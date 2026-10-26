package com.cc01cc.p.xihe.cp.config;

import jakarta.servlet.http.HttpServletRequest;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.dao.CannotAcquireLockException;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.context.request.async.AsyncRequestNotUsableException;
import org.springframework.security.access.AccessDeniedException;
import org.springframework.web.bind.MethodArgumentNotValidException;
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

    @ExceptionHandler({IllegalArgumentException.class, HttpMessageNotReadableException.class,
            MethodArgumentNotValidException.class})
    public ResponseEntity<Map<String, Object>> badRequest(Exception exception, HttpServletRequest request) {
        if (exception instanceof CpApiException apiException) {
            logger.warn("Domain failure at {}: {}", request.getRequestURI(), apiException.getMessage());
            return apiException.getRequestId() == null
                    ? problem(apiException.getStatus(), apiException.getCode(), apiException.getMessage(), request)
                    : problem(apiException.getStatus(), apiException.getCode(), apiException.getMessage(),
                    apiException.getRequestId());
        }
        logger.warn("Bad request at {}", request.getRequestURI(), exception);
        return problem(HttpStatus.BAD_REQUEST, "INVALID_REQUEST", "Request validation failed", request);
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
