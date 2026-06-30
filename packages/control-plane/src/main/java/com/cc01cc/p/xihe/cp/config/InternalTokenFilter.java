package com.cc01cc.p.xihe.cp.config;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;
import java.util.List;

@Component
public class InternalTokenFilter extends OncePerRequestFilter {

    private static final Logger log = LoggerFactory.getLogger(InternalTokenFilter.class);

    private final String expectedToken;

    public InternalTokenFilter(
            @Value("${cp.agent-api-token:dev-token-not-secure}") String expectedToken) {
        this.expectedToken = expectedToken;
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response,
                                    FilterChain filterChain) throws ServletException, IOException {
        String token = request.getHeader("X-Api-Token");
        if (token != null && token.equals(expectedToken)) {
            SecurityContextHolder.getContext().setAuthentication(
                new UsernamePasswordAuthenticationToken(
                    "internal-service", null,
                    List.of(new SimpleGrantedAuthority("ROLE_INTERNAL_SERVICE"))
                )
            );
            log.debug("Internal token authenticated: {} {}", request.getMethod(), request.getRequestURI());
        }
        filterChain.doFilter(request, response);
    }
}
