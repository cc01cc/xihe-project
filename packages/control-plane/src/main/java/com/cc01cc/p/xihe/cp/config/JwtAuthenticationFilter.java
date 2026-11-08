package com.cc01cc.p.xihe.cp.config;

import com.cc01cc.p.xihe.cp.policy.AuthzContext;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.GrantedAuthority;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

/**
 * PLAN-0580 decision #14: authentication requires a valid signature <b>and</b> a
 * matching access-token epoch.
 *
 * <p>PLAN-0610 W1b (R2-5): the authorities of an authenticated user are</p>
 *
 * <ul>
 *   <li>the binding-backed capabilities of the subject, from {@link AuthzContext}
 *       ({@code cap:instance:super} / {@code cap:instance:admin}) — these are the only
 *       authorities any decision may read;</li>
 *   <li>PLAN-0610 W3-2b: the legacy {@code ROLE_<claim role>} compatibility authority is <b>gone</b> —
 *       the claim itself is no longer issued, so there is nothing to project;</li>
 *       {@code @PreAuthorize} expressions (W1b-2). It is derived from the signed claim exactly as
 *       before, is never read by the URL layer anymore, and disappears with the claim rewrite.</li>
 * </ul>
 *
 * <p>Fail-closed: a failure while resolving capabilities grants no capability (the request keeps
 * only its compatibility role authority) instead of failing the request — the security chain then
 * denies everything that requires a capability.</p>
 *
 * <p>This filter has no try/catch of its own, so every rejection has to be a
 * decision (no authentication) rather than an exception:
 * {@link AccessTokenAuthenticator} owns the three fail-closed states (non-UUID
 * subject / unknown user row / missing or stale {@code tv}) and returns empty
 * for all of them. The security chain then answers 401
 * {@code AUTHORIZATION_REQUIRED}.
 */
@Component
public class JwtAuthenticationFilter extends OncePerRequestFilter {

    private static final Logger logger = LoggerFactory.getLogger(JwtAuthenticationFilter.class);

    private final AccessTokenAuthenticator tokenAuthenticator;
    private final AuthzContext authzContext;

    public JwtAuthenticationFilter(AccessTokenAuthenticator tokenAuthenticator,
                                   AuthzContext authzContext) {
        this.tokenAuthenticator = tokenAuthenticator;
        this.authzContext = authzContext;
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain filterChain)
            throws ServletException, IOException {

        String authHeader = request.getHeader("Authorization");
        String token = null;

        if (authHeader != null && authHeader.startsWith("Bearer ")) {
            token = authHeader.substring(7);
        }

        Optional<AccessTokenAuthenticator.AuthenticatedUser> authenticated =
                tokenAuthenticator.authenticate(token);
        if (authenticated.isPresent()) {
            AccessTokenAuthenticator.AuthenticatedUser user = authenticated.get();
            List<GrantedAuthority> authorities = new ArrayList<>(capabilityAuthorities(user.userId()));

            UsernamePasswordAuthenticationToken authentication =
                    new UsernamePasswordAuthenticationToken(user.userId(), null, authorities);
            SecurityContextHolder.getContext().setAuthentication(authentication);
        }

        filterChain.doFilter(request, response);
    }

    private List<GrantedAuthority> capabilityAuthorities(String userId) {
        UUID subjectId;
        try {
            subjectId = UUID.fromString(userId);
        } catch (IllegalArgumentException | NullPointerException e) {
            return List.of();
        }
        try {
            List<GrantedAuthority> authorities = new ArrayList<>();
            authzContext.authoritiesFor(subjectId)
                    .forEach(capability -> authorities.add(new SimpleGrantedAuthority(capability)));
            return authorities;
        } catch (RuntimeException e) {
            logger.warn("[AUTH] capability resolution failed, granting none: {}", e.getMessage());
            return List.of();
        }
    }
}
