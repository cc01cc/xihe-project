package com.cc01cc.p.xihe.cp.auth;

import jakarta.annotation.PostConstruct;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import com.cc01cc.p.xihe.cp.config.CpApiException;

/**
 * PLAN-0581 §6 / decision #8/#15: the single point that decides whether public
 * self-registration is open.
 *
 * <p>{@code XIHE_AUTH_REGISTRATION_POLICY} is a <b>bootstrap env</b> switch, not
 * a ConfigService key (v1 has no admin UI for it; BL-73 upgrades this to an
 * invite model later). Default {@code open} keeps already-deployed instances
 * working — a surprising 403 on the register endpoint would be worse than the
 * status quo.
 *
 * <p>Local single-user mode is deliberately exempt: the instance must be able to
 * create its first (only) account even with registration closed, otherwise a
 * fresh machine with {@code XIHE_LOCAL_MODE=true} + {@code closed} would be
 * permanently unusable (I5).
 */
@Service
public class RegistrationPolicy {

    private static final Logger logger = LoggerFactory.getLogger(RegistrationPolicy.class);

    static final String POLICY_KEY = "XIHE_AUTH_REGISTRATION_POLICY";

    private final String rawPolicy;

    public RegistrationPolicy(@Value("${" + POLICY_KEY + ":}") String rawPolicy) {
        this.rawPolicy = rawPolicy;
    }

    /**
     * Fail-fast on an unrecognised value (precedent: {@code LocalModeService}
     * validates its env in {@code @PostConstruct}). A typo such as
     * {@code "Closed"} or {@code "false"} must stop the process instead of
     * silently falling back to {@code open} and exposing registration.
     */
    @PostConstruct
    public void validate() {
        String normalized = normalize(rawPolicy);
        if (normalized == null) {
            logger.error("Refusing to start: {}='{}' is not one of open|closed. "
                    + "Unset it for the default (open) or set it to closed.",
                    POLICY_KEY, rawPolicy);
            throw new IllegalStateException(
                    POLICY_KEY + " must be 'open' or 'closed' (got: " + rawPolicy + ")");
        }
        logger.info("Registration policy: {}", normalized);
    }

    /** Default open: an absent value must behave like {@code XIHE_AUTH_REGISTRATION_POLICY=open}. */
    public boolean isOpen() {
        String normalized = normalize(rawPolicy);
        // validate() already rejected invalid values at startup; treat a null here
        // (only reachable if the bean is constructed outside a Spring context) as open.
        return normalized == null || "open".equals(normalized);
    }

    /**
     * Closed means: public registration is refused with a stable 403 §5 code, and
     * the only way to add an account is the ADMIN route {@code POST /api/v1/users}.
     * The caller is responsible for placing this check <b>after</b> the 0558 IP
     * throttle and before any user row is created (§6).
     */
    public void requireOpen() {
        if (!isOpen()) {
            throw new CpApiException(HttpStatus.FORBIDDEN, "REGISTRATION_CLOSED",
                    "Self-registration is disabled on this instance");
        }
    }

    private static String normalize(String value) {
        if (value == null || value.isBlank()) {
            return "open";
        }
        String trimmed = value.trim().toLowerCase(java.util.Locale.ROOT);
        return switch (trimmed) {
            case "open", "closed" -> trimmed;
            default -> null;
        };
    }
}
