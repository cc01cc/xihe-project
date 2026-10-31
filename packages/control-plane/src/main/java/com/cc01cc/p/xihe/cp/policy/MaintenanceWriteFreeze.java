package com.cc01cc.p.xihe.cp.policy;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import jakarta.annotation.PostConstruct;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;

/**
 * PLAN-0610 T2.2: maintenance-window write freeze for the V88 data copy.
 *
 * <p>The one-shot migration window must not interleave with member/role writes: a membership row
 * added after the copy would be missing from the bindings ("member resurrection" risk, design
 * #19). While the switch is on, the member and role write paths answer
 * {@code 503 MIGRATION_IN_PROGRESS} instead of mutating the legacy facts.</p>
 *
 * <p>Operational contract: a static bootstrap env, default <b>off</b> (daily development and the
 * normal test suites are unaffected). The window sequence is: stop writes → run V88 → deploy the
 * switching code (W1b) → clear the flag. Read paths are never blocked.</p>
 */
@Service
public class MaintenanceWriteFreeze {

    private static final Logger logger = LoggerFactory.getLogger(MaintenanceWriteFreeze.class);

    public static final String KEY = "XIHE_MIGRATION_WINDOW_FREEZE_WRITES";

    public static final String DETAIL =
            "The instance is inside the PLAN-0610 access-role migration window: member and role "
                    + "writes are frozen until the V88 copy finishes. Retry after the window closes.";

    private final String rawValue;

    public MaintenanceWriteFreeze(@Value("${" + KEY + ":}") String rawValue) {
        this.rawValue = rawValue;
    }

    @PostConstruct
    public void validate() {
        String normalized = normalize(rawValue);
        if (normalized == null) {
            logger.error("Refusing to start: {}='{}' is not one of true|false. "
                    + "Unset it for the default (off) or set it to true during the migration window.",
                    KEY, rawValue);
            throw new IllegalStateException(KEY + " must be 'true' or 'false' (got: " + rawValue + ")");
        }
        if ("true".equals(normalized)) {
            logger.warn("Maintenance write freeze is ON ({}): member/role writes answer 503 "
                    + "MIGRATION_IN_PROGRESS", KEY);
        }
    }

    /** Default off: an absent value must behave like {@code XIHE_MIGRATION_WINDOW_FREEZE_WRITES=false}. */
    public boolean isFrozen() {
        return "true".equals(normalize(rawValue));
    }

    /** Called by the member/role write paths; {@code surface} only shows up in the message. */
    public void requireWritable(String surface) {
        if (isFrozen()) {
            throw new CpApiException(HttpStatus.SERVICE_UNAVAILABLE, "MIGRATION_IN_PROGRESS",
                    DETAIL + " (blocked: " + surface + ")");
        }
    }

    private static String normalize(String value) {
        if (value == null || value.isBlank()) {
            return "false";
        }
        String trimmed = value.trim().toLowerCase(java.util.Locale.ROOT);
        return switch (trimmed) {
            case "true", "false" -> trimmed;
            default -> null;
        };
    }
}
