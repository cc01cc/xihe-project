package com.cc01cc.p.xihe.cp.config;

import org.springframework.http.HttpStatus;

/** A domain failure with a stable HTTP problem code. */
public class CpApiException extends IllegalArgumentException {

    private final HttpStatus status;
    private final String code;
    private final String requestId;

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
