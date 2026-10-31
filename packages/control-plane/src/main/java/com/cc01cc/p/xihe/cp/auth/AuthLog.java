package com.cc01cc.p.xihe.cp.auth;

/**
 * PLAN-0558: keeps auth log/audit fields free of raw emails and client-supplied
 * separators. Package-private until PLAN-0581 needed the same masking for the
 * admin-create audit row in {@code service/UserAdminService}.
 */
public final class AuthLog {

    private AuthLog() {}

    public static String maskEmail(String email) {
        if (email == null || email.isBlank()) {
            return "unknown";
        }
        int at = email.indexOf('@');
        if (at <= 0) {
            return "***";
        }
        return email.substring(0, 1) + "***" + email.substring(at);
    }

    static String safeRequestId(String requestId) {
        if (requestId == null) {
            return "unknown";
        }
        String value = requestId.trim();
        return value.matches("[A-Za-z0-9._:-]{1,128}") ? value : "invalid";
    }
}
