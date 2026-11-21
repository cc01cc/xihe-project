package com.cc01cc.p.xihe.cp.config;

import jakarta.servlet.http.HttpServletRequest;

import java.net.InetAddress;
import java.net.UnknownHostException;
import java.util.Locale;
import java.util.Optional;
import java.util.Set;
import java.util.function.Function;
import java.util.regex.Pattern;

/**
 * D-1535 ③ (task-5, formerly task-149): the local-only gate in front of the first-run credential
 * disclosure.
 *
 * <p><b>Why loopback alone is not enough.</b> The disclosure sits inside the window where the
 * instance has no usable login yet, so it cannot require a Bearer token; the only thing standing
 * between a fresh install and a remote caller is the caller's locality. A TCP peer address is not a
 * browser boundary though: a page the operator visits can POST to {@code 127.0.0.1} from their own
 * browser (the packet is genuinely loopback). The three checks below close that hole together:</p>
 *
 * <ul>
 *   <li><b>peer</b> — {@code getRemoteAddr()} must be a loopback address literal (the raw peer, never
 *       {@code X-Forwarded-For}: a header is caller-controlled);</li>
 *   <li><b>Host</b> — the {@code Host} header must name a loopback host, so a DNS-rebinding name
 *       resolved to loopback is refused;</li>
 *   <li><b>Origin</b> — a <i>present</i> {@code Origin} must be an http(s) loopback origin. Browsers
 *       send {@code Origin} on every cross-site POST and on same-origin POST, so this is the check
 *       that refuses the "operator's browser is the attacker" case. A request with no {@code Origin}
 *       is not a browser fetch (curl / a local script) and is already loopback-bound, so absence is
 *       allowed instead of forcing every local CLI to synthesize a header.</li>
 * </ul>
 *
 * <p><b>Not byte-equal same-origin, deliberately.</b> The dev stack proxies {@code /api} from the UI
 * origin ({@code localhost:12640}) to the CP origin ({@code 127.0.0.1:12641}) with
 * {@code changeOrigin}, so {@code Origin} and {@code Host} name different ports for the product's
 * own first-run page. Requiring equality would close the endpoint on the very path it exists for.
 * Both headers are still checked; what is pinned is "loopback names on both axes", and the residual
 * exposure (another local dev server on this machine could call it) is the same exposure any local
 * process already has.</p>
 *
 * <p><b>prod fail-fast.</b> {@code XIHE_ENV=prod} closes the face unconditionally: a deployment has
 * an operator-supplied credential and must never expose a generated one. The check reads the same
 * lookup order as {@code SecurityDefaultsValidator} (env-file chain first, then OS env), so a
 * {@code .env} value that landed in system properties wins as it does everywhere else.</p>
 */
public final class FirstRunLocalAccess {

    static final String ENV_NAME_KEY = "XIHE_ENV";
    static final String PROD_ENV = "prod";

    /** Loopback spellings a browser may legitimately put in {@code Host} / {@code Origin}. */
    private static final Set<String> LOOPBACK_HOSTS = Set.of("127.0.0.1", "localhost", "[::1]", "::1");

    /**
     * Numeric literals only. {@link InetAddress#getByName(String)} resolves names (DNS), so feeding a
     * caller-controlled string straight into it would turn a gate into a resolver.
     */
    private static final Pattern IP_LITERAL = Pattern.compile("^[0-9A-Fa-f:.]+$");

    private FirstRunLocalAccess() {}

    /** Same lookup order as {@code SecurityDefaultsValidator}: system property (env-file chain) then env. */
    public static String envValue(String key) {
        String property = System.getProperty(key);
        return property != null ? property : System.getenv(key);
    }

    /**
     * @return an empty optional when the caller is a local first-run caller; otherwise the gate that
     *     refused it (a short token for the problem detail — never request data).
     */
    public static Optional<String> denial(HttpServletRequest request, Function<String, String> env) {
        if (PROD_ENV.equalsIgnoreCase(trim(env.apply(ENV_NAME_KEY)))) {
            return Optional.of("prod");
        }
        if (!isLoopbackAddress(request.getRemoteAddr())) {
            return Optional.of("peer");
        }
        String host = hostOnly(request.getHeader("Host"));
        if (host == null || !LOOPBACK_HOSTS.contains(host)) {
            return Optional.of("host");
        }
        String origin = request.getHeader("Origin");
        if (origin != null && !origin.isBlank() && !isLoopbackOrigin(origin)) {
            return Optional.of("origin");
        }
        return Optional.empty();
    }

    private static boolean isLoopbackAddress(String address) {
        if (address == null || address.isBlank() || !IP_LITERAL.matcher(address).matches()) {
            return false;
        }
        try {
            return InetAddress.getByName(address).isLoopbackAddress();
        } catch (UnknownHostException e) {
            return false;
        }
    }

    /** Strip the optional port, keeping the brackets of an IPv6 literal so {@code [::1]} stays nameable. */
    private static String hostOnly(String header) {
        if (header == null) {
            return null;
        }
        String value = header.trim().toLowerCase(Locale.ROOT);
        if (value.isEmpty()) {
            return null;
        }
        if (value.startsWith("[")) {
            int end = value.indexOf(']');
            return end < 0 ? null : value.substring(0, end + 1);
        }
        int colon = value.lastIndexOf(':');
        if (colon > 0 && value.indexOf(':') == colon
                && value.substring(colon + 1).chars().allMatch(Character::isDigit)) {
            return value.substring(0, colon);
        }
        return value;
    }

    private static boolean isLoopbackOrigin(String origin) {
        String value = origin.trim().toLowerCase(Locale.ROOT);
        int schemeEnd = value.indexOf("://");
        if (schemeEnd < 0) {
            return false;
        }
        String scheme = value.substring(0, schemeEnd);
        if (!"http".equals(scheme) && !"https".equals(scheme)) {
            return false;
        }
        String authority = value.substring(schemeEnd + 3);
        int path = authority.indexOf('/');
        if (path >= 0) {
            authority = authority.substring(0, path);
        }
        String host = hostOnly(authority);
        return host != null && LOOPBACK_HOSTS.contains(host);
    }

    private static String trim(String value) {
        return value == null ? null : value.trim();
    }
}
