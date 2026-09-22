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

    public String getCode() {
        return code;
    }

    public String getRequestId() {
        return requestId;
    }
}
