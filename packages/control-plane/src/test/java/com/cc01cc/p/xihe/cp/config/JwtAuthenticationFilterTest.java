package com.cc01cc.p.xihe.cp.config;

import jakarta.servlet.FilterChain;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.security.core.context.SecurityContextHolder;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

class JwtAuthenticationFilterTest {

    private final JwtTokenProvider jwtProvider = mock(JwtTokenProvider.class);
    private final JwtAuthenticationFilter filter = new JwtAuthenticationFilter(jwtProvider);

    @AfterEach
    void tearDown() {
        SecurityContextHolder.clearContext();
    }

    @Test
    void validToken_setsAuthentication() throws Exception {
        var request = mock(HttpServletRequest.class);
        var response = mock(HttpServletResponse.class);
        var chain = mock(FilterChain.class);
        when(request.getHeader("Authorization")).thenReturn("Bearer valid-jwt");
        when(jwtProvider.validateToken("valid-jwt")).thenReturn(true);
        when(jwtProvider.getUserIdFromToken("valid-jwt")).thenReturn("user-1");
        when(jwtProvider.getRoleFromToken("valid-jwt")).thenReturn("USER");

        filter.doFilterInternal(request, response, chain);

        var auth = SecurityContextHolder.getContext().getAuthentication();
        assertNotNull(auth);
        assertEquals("user-1", auth.getPrincipal());
        assertTrue(auth.getAuthorities().stream()
            .anyMatch(a -> a.getAuthority().equals("ROLE_USER")));
    }

    @Test
    void invalidToken_doesNotSetAuthentication() throws Exception {
        var request = mock(HttpServletRequest.class);
        var response = mock(HttpServletResponse.class);
        var chain = mock(FilterChain.class);
        when(request.getHeader("Authorization")).thenReturn("Bearer invalid-jwt");
        when(jwtProvider.validateToken("invalid-jwt")).thenReturn(false);

        filter.doFilterInternal(request, response, chain);

        assertNull(SecurityContextHolder.getContext().getAuthentication());
    }

    @Test
    void missingHeader_doesNotSetAuthentication() throws Exception {
        var request = mock(HttpServletRequest.class);
        var response = mock(HttpServletResponse.class);
        var chain = mock(FilterChain.class);
        when(request.getHeader("Authorization")).thenReturn(null);

        filter.doFilterInternal(request, response, chain);

        assertNull(SecurityContextHolder.getContext().getAuthentication());
    }

    @Test
    void nonBearerHeader_doesNotSetAuthentication() throws Exception {
        var request = mock(HttpServletRequest.class);
        var response = mock(HttpServletResponse.class);
        var chain = mock(FilterChain.class);
        when(request.getHeader("Authorization")).thenReturn("Basic credentials");

        filter.doFilterInternal(request, response, chain);

        assertNull(SecurityContextHolder.getContext().getAuthentication());
    }

    @Test
    void alwaysInvokesFilterChain() throws Exception {
        var request = mock(HttpServletRequest.class);
        var response = mock(HttpServletResponse.class);
        var chain = mock(FilterChain.class);
        when(request.getHeader("Authorization")).thenReturn(null);

        filter.doFilterInternal(request, response, chain);

        verify(chain).doFilter(request, response);
    }
}
