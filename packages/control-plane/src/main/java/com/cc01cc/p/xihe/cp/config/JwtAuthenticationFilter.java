package com.cc01cc.p.xihe.cp.config;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;
import java.util.List;
import java.util.Optional;

/**
 * PLAN-0580 decision #14: authentication requires a valid signature <b>and</b> a
 * matching access-token epoch.
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

    private final AccessTokenAuthenticator tokenAuthenticator;

    public JwtAuthenticationFilter(AccessTokenAuthenticator tokenAuthenticator) {
        this.tokenAuthenticator = tokenAuthenticator;
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
            List<SimpleGrantedAuthority> authorities = List.of(
                    new SimpleGrantedAuthority("ROLE_" + user.role())
            );

            UsernamePasswordAuthenticationToken authentication =
                    new UsernamePasswordAuthenticationToken(user.userId(), null, authorities);
            SecurityContextHolder.getContext().setAuthentication(authentication);
        }

        filterChain.doFilter(request, response);
    }
}
