package com.cc01cc.p.xihe.cp.logging;

import java.util.List;
import java.util.regex.Pattern;

/**
 * Log redaction at the encoder serialization boundary (PLAN-196 M1).
 */
public final class LogRedactor {

    public static final String REDACTED = "***redacted***";

    private static final List<Pattern> VALUE_PATTERNS = List.of(
        Pattern.compile("Bearer\\s+[A-Za-z0-9._~+/=-]+", Pattern.CASE_INSENSITIVE),
        Pattern.compile("eyJ[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+"),
        Pattern.compile(
            "-----BEGIN [A-Z ]*PRIVATE KEY-----.*?-----END [A-Z ]*PRIVATE KEY-----",
            Pattern.DOTALL
        ),
        Pattern.compile(
            "(\"(?:access_?token|refresh_?token|api_?key|service_?token|client_?secret"
                + "|token|secret|password|authorization|cookie|pkce|verifier)\"\\s*:\\s*\")[^\"]*\"",
            Pattern.CASE_INSENSITIVE
        )
    );

    private LogRedactor() {
    }

    public static String redact(String text) {
        if (text == null || text.isEmpty()) {
            return text;
        }
        String result = text;
        for (Pattern pattern : VALUE_PATTERNS) {
            result = pattern.matcher(result).replaceAll(match -> {
                if (match.groupCount() >= 1 && match.group(1) != null) {
                    return java.util.regex.Matcher.quoteReplacement(
                        match.group(1) + REDACTED + "\""
                    );
                }
                return REDACTED;
            });
        }
        return result;
    }
}
