package com.cc01cc.p.xihe.cp.plugin.kv;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;
import java.util.List;

/**
 * PLAN-0691 T1.5: authenticates the binding-scoped token on the KV data plane
 * (spec/data-plane.md SEC-1).
 *
 * <p>SEC-1 requires that a binding token is the <em>only</em> accepted credential on this surface and
 * that the global {@code ROLE_INTERNAL_SERVICE} token is rejected with 403. That is enforced in two
 * halves: this filter turns a valid binding token into the {@value #AUTHORITY} authority, and
 * {@code SecurityConfig} requires that authority on exactly {@link #KV_PATH_PATTERN} and
 * {@link #RECORDS_PATH_PATTERN}. The internal
 * service token authenticates through {@code InternalTokenFilter} with a different authority, so it
 * ends up authenticated-but-forbidden (403), not unauthenticated (401) — the distinction SEC-1 asks
 * for.
 *
 * <p>The filter only <em>authenticates</em>; it never decides 403. Path/token binding mismatch and
 * binding state are checked in {@link PluginKvService} (SEC-2) so that the check sits next to the
 * binding row read and applies to every endpoint, including future ones.
 *
 * <p>A rejected token leaves the request unauthenticated instead of throwing: the filter chain then
 * reaches Spring Security's entry point, which renders the CP-wide 401
 * {@code AUTHORIZATION_REQUIRED} problem document. Throwing here would bypass the configured entry
 * point and produce a differently shaped error body on the same surface.
 */
@Component
public class PluginKvTokenFilter extends OncePerRequestFilter {

    /** Authority that only a verified binding-scoped token can carry. */
    public static final String AUTHORITY = "PLUGIN_KV_BINDING";

    /** Security-matcher pattern for the KV data plane; registered in {@code SecurityConfig}. */
    public static final String KV_PATH_PATTERN = "/internal/v1/plugin-bindings/*/kv/**";

    /**
     * Security-matcher pattern for the records data plane (PLAN-0691 T2.3), registered next to
     * {@link #KV_PATH_PATTERN}.
     *
     * <p>The same filter and the same authority serve both surfaces on purpose: they share one
     * credential (SEC-1's binding-scoped token, TTL 300s) and one claim shape, so a second filter would
     * only duplicate the verification and risk the two surfaces drifting apart.
     */
    public static final String RECORDS_PATH_PATTERN = "/internal/v1/plugin-bindings/*/records/**";

    /**
     * Request attribute through which the controller reads the verified claims.
     *
     * <p>A literal (not {@code getClass().getName() + …}) because {@code @RequestAttribute} needs a
     * compile-time constant; the {@code cp.plugin.kv.} prefix keeps it out of the way of other
     * packages' attributes.
     */
    public static final String CLAIMS_ATTRIBUTE = "cp.plugin.kv.claims";

    private static final String PATH_PREFIX = "/internal/v1/plugin-bindings/";
    private static final String KV_SEGMENT = "/kv/";
    private static final String RECORDS_SEGMENT = "/records/";
    private static final String BEARER = "Bearer ";

    private static final Logger logger = LoggerFactory.getLogger(PluginKvTokenFilter.class);

    private final PluginKvTokenService tokenService;

    public PluginKvTokenFilter(PluginKvTokenService tokenService) {
        this.tokenService = tokenService;
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response,
                                    FilterChain filterChain) throws ServletException, IOException {
        String path = request.getRequestURI();
        if (!path.startsWith(PATH_PREFIX)
                || !(path.contains(KV_SEGMENT) || path.contains(RECORDS_SEGMENT))) {
            filterChain.doFilter(request, response);
            return;
        }
        String header = request.getHeader("Authorization");
        if (header == null || !header.startsWith(BEARER)) {
            filterChain.doFilter(request, response);
            return;
        }
        PluginKvClaims claims;
        try {
            claims = tokenService.verify(header.substring(BEARER.length()).trim());
        } catch (CpApiException e) {
            // Not logged with the token; the reason string never contains it either.
            logger.debug("plugin kv binding token rejected for {}: {}", path, e.getMessage());
            filterChain.doFilter(request, response);
            return;
        }
        UsernamePasswordAuthenticationToken authentication = new UsernamePasswordAuthenticationToken(
                claims.bindingId(), null, List.of(new SimpleGrantedAuthority(AUTHORITY)));
        authentication.setDetails(claims);
        SecurityContextHolder.getContext().setAuthentication(authentication);
        request.setAttribute(CLAIMS_ATTRIBUTE, claims);
        filterChain.doFilter(request, response);
    }
}
