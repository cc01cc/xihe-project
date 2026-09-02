package com.cc01cc.p.xihe.cp.config;

import org.springframework.http.HttpStatus;

/** A domain failure with a stable HTTP problem code. */
public class CpApiException extends IllegalArgumentException {

    private final HttpStatus status;
    private final String code;

    public CpApiException(HttpStatus status, String code, String detail) {
        super(detail);
        this.status = status;
        this.code = code;
    }

    public CpApiException(HttpStatus status, String code, String detail, Throwable cause) {
        super(detail, cause);
        this.status = status;
        this.code = code;
    }

    public HttpStatus getStatus() {
        return status;
    }

    public String getCode() {
        return code;
    }
}
