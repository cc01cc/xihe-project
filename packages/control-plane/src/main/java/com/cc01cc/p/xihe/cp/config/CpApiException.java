package com.cc01cc.p.xihe.cp.config;

import org.springframework.http.HttpStatus;

import java.util.LinkedHashMap;
import java.util.Map;

/** A domain failure with a stable HTTP problem code. */
public class CpApiException extends IllegalArgumentException {

    private final HttpStatus status;
    private final String code;
    private final String requestId;
    /** Extra problem fields (e.g. export {@code messages}/{@code limit}); empty by default. */
    private Map<String, Object> extra = Map.of();

    public CpApiException(HttpStatus status, String code, String detail) {
        super(detail);
        this.status = status;
        this.code = code;
        this.requestId = null;
    }

    public CpApiException(HttpStatus status, String code, String detail, Throwable cause) {
        super(detail, cause);
        this.status = status;
        this.code = code;
        this.requestId = null;
    }

    public CpApiException(HttpStatus status, String code, String detail, String requestId) {
        super(detail);
        this.status = status;
        this.code = code;
        this.requestId = requestId;
    }

    /**
     * Attaches extra fields to the RFC 9457 problem body. Used by faces that must throw (to keep a
     * streaming return type) but whose contract still carries machine-readable details.
     */
    public CpApiException withExtra(Map<String, Object> extra) {
        this.extra = extra == null ? Map.of() : new LinkedHashMap<>(extra);
        return this;
    }

    public Map<String, Object> getExtra() {
        return extra;
    }

    public HttpStatus getStatus() {
        return status;
    }

    /**
     * The service-layer twin of {@code ProblemDetailsHandler.workspaceContextRequired()}: 409
     * {@code WORKSPACE_CONTEXT_REQUIRED} for "authenticated, but no workspace context was resolved".
     */
    public static CpApiException workspaceContextRequired() {
        return new CpApiException(org.springframework.http.HttpStatus.CONFLICT,
                "WORKSPACE_CONTEXT_REQUIRED", "Workspace context is required");
    }

    public String getCode() {
        return code;
    }

    public String getRequestId() {
        return requestId;
    }
}
