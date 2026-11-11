package com.cc01cc.p.xihe.cp.service;

import java.util.Locale;
import java.util.UUID;

/**
 * Normalization shared by the env three-state check and the runtime owner comparisons
 * (PLAN-0767 M1-3 spec §3): a deployment identity may be written as a canonical UUID or as the
 * 32-hex deployment-id file form; comparisons are case-insensitive and dash-insensitive.
 */
public final class InstanceIdentityFormat {

    private static final int CANONICAL_LENGTH = 36;
    private static final int HEX_LENGTH = 32;

    private InstanceIdentityFormat() {
    }

    /** Parses a UUID or 32-hex deployment id; returns {@code null} for anything invalid/blank. */
    public static UUID parse(String raw) {
        if (raw == null) {
            return null;
        }
        String trimmed = raw.trim();
        if (trimmed.isEmpty()) {
            return null;
        }
        String canonical = trimmed;
        if (trimmed.length() == HEX_LENGTH && isHex(trimmed)) {
            canonical = trimmed.substring(0, 8) + "-" + trimmed.substring(8, 12) + "-"
                    + trimmed.substring(12, 16) + "-" + trimmed.substring(16, 20) + "-"
                    + trimmed.substring(20);
        }
        if (canonical.length() != CANONICAL_LENGTH) {
            return null;
        }
        try {
            return UUID.fromString(canonical.toLowerCase(Locale.ROOT));
        } catch (IllegalArgumentException e) {
            return null;
        }
    }

    /** Canonical lowercase dashed form, or {@code null} when {@code raw} is not an identity. */
    public static String normalize(String raw) {
        UUID parsed = parse(raw);
        return parsed == null ? null : parsed.toString();
    }

    /** Dash-insensitive, case-insensitive comparison used by {@code isInstanceOwnerId}. */
    public static boolean equalsIdentity(String left, String right) {
        UUID leftParsed = parse(left);
        UUID rightParsed = parse(right);
        return leftParsed != null && leftParsed.equals(rightParsed);
    }

    private static boolean isHex(String value) {
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            boolean digit = c >= '0' && c <= '9';
            boolean lower = c >= 'a' && c <= 'f';
            boolean upper = c >= 'A' && c <= 'F';
            if (!digit && !lower && !upper) {
                return false;
            }
        }
        return true;
    }
}
