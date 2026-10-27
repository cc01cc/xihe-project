package com.cc01cc.p.xihe.cp.auth;

/**
 * PLAN-0558: credential-only failure (unknown account or wrong password).
 * Callers may count this for login lockout; workspace/token failures are not
 * credentials and must not be counted.
 */
public class InvalidCredentialsException extends IllegalArgumentException {

    public InvalidCredentialsException(String message) {
        super(message);
    }
}
