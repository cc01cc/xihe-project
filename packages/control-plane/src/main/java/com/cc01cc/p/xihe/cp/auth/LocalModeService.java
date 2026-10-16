package com.cc01cc.p.xihe.cp.auth;

import jakarta.annotation.PostConstruct;
import jakarta.servlet.http.HttpServletRequest;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import com.cc01cc.p.xihe.cp.config.CpApiException;

import java.net.InetAddress;
import java.net.URI;
import java.net.URISyntaxException;
import java.net.UnknownHostException;

/**
 * PLAN-0526: single-user local mode gate for the passwordless local entry.
 *
 * <p>Local mode is an explicit exception to the fail-closed auth entry. It is
 * usable only when {@code XIHE_LOCAL_MODE=true}, the CP is bound to a loopback
 * address, the request originates from loopback, and the browser {@code Origin}
 * (or, when absent, {@code Host}) is a loopback host. The last condition stops
 * cross-site requests from arbitrary pages and DNS-rebinding, which a bare
 * remote-address check does not.
 */
@Service
public class LocalModeService {

    private static final Logger logger = LoggerFactory.getLogger(LocalModeService.class);
    private static final String ENABLED_KEY = "XIHE_LOCAL_MODE";
    private static final String PROD_ENV_NAME = "prod";

    private final String boundAddress;

    public LocalModeService(@Value("${server.address:}") String boundAddress) {
        this.boundAddress = boundAddress;
    }

    /** True when local mode is explicitly enabled. */
    public boolean enabled() {
        return "true".equalsIgnoreCase(effective(ENABLED_KEY));
    }

    /**
     * Fail-fast: local mode is only coherent on a loopback-bound, non-prod CP.
     * Binding elsewhere (or prod) refuses startup and lists the offending keys.
     */
    @PostConstruct
    public void validateBinding() {
        if (!enabled()) {
            return;
        }
        boolean prod = PROD_ENV_NAME.equals(effective("XIHE_ENV"));
        boolean loopbackBound = isLoopbackHostName(hostWithoutPort(boundAddress));
        if (prod || !loopbackBound) {
            logger.error("Refusing to start: XIHE_LOCAL_MODE=true requires a loopback-bound, "
                    + "non-prod CP (XIHE_ENV={}, server.address='{}'). "
                    + "Set server.address=127.0.0.1 (e.g. SERVER_ADDRESS=127.0.0.1) and do not run "
                    + "local mode in prod, or set XIHE_LOCAL_MODE=false.", effective("XIHE_ENV"), boundAddress);
            throw new IllegalStateException(
                    "XIHE_LOCAL_MODE requires loopback binding and non-prod environment");
        }
    }

    /**
     * I1 gate for {@code local-login} and {@code local-password-reset} (and the
     * password-omitted register branch). Fails closed as 404 to conceal the
     * endpoint when local mode does not apply.
     */
    public void requireLocalAccess(HttpServletRequest request) {
        if (!enabled()
                || !isLoopbackAddress(request.getRemoteAddr())
                || !isOriginOrHostLoopback(request)) {
            throw new CpApiException(HttpStatus.NOT_FOUND, "NOT_FOUND", "Resource not found");
        }
    }

    private static boolean isOriginOrHostLoopback(HttpServletRequest request) {
        String origin = request.getHeader("Origin");
        if (origin != null && !origin.isBlank()) {
            try {
                return isLoopbackHostName(new URI(origin).getHost());
            } catch (URISyntaxException e) {
                return false;
            }
        }
        return isLoopbackHostName(hostWithoutPort(request.getHeader("Host")));
    }

    /** Numeric literal only; never resolves names, so it cannot be fooled by rebinding. */
    private static boolean isLoopbackAddress(String address) {
        if (address == null || address.isBlank()) {
            return false;
        }
        try {
            return InetAddress.getByName(address).isLoopbackAddress();
        } catch (UnknownHostException e) {
            return false;
        }
    }

    /** Literal comparison only, no DNS resolution (rebinding-safe). */
    private static boolean isLoopbackHostName(String host) {
        if (host == null || host.isBlank()) {
            return false;
        }
        String value = host.trim();
        return "localhost".equalsIgnoreCase(value)
                || "::1".equals(value)
                || value.startsWith("127.");
    }

    private static String hostWithoutPort(String hostValue) {
        if (hostValue == null) {
            return null;
        }
        String value = hostValue.trim();
        if (value.startsWith("[")) {
            int end = value.indexOf(']');
            return end > 0 ? value.substring(1, end) : value;
        }
        int colon = value.indexOf(':');
        return colon >= 0 ? value.substring(0, colon) : value;
    }

    private static String effective(String key) {
        String property = System.getProperty(key);
        return property != null ? property : System.getenv(key);
    }
}
