package com.cc01cc.p.xihe.cp.config;

import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.entity.UserRole;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import jakarta.servlet.FilterChain;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.security.core.context.SecurityContextHolder;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class JwtAuthenticationFilterTest {

    private static final String USER_ID = "11111111-1111-4111-8111-111111111111";

    private final JwtTokenProvider jwtProvider = mock(JwtTokenProvider.class);
    private final UserRepository userRepository = mock(UserRepository.class);
    private final com.cc01cc.p.xihe.cp.policy.AuthzContext authzContext =
            mock(com.cc01cc.p.xihe.cp.policy.AuthzContext.class);
    private final JwtAuthenticationFilter filter = new JwtAuthenticationFilter(
            new AccessTokenAuthenticator(jwtProvider, userRepository), authzContext);

    @AfterEach
    void tearDown() {
        SecurityContextHolder.clearContext();
    }

    /** PLAN-0580: a matching epoch authenticates with the principal being the user id. */
    @Test
    void validToken_setsAuthentication() throws Exception {
        var request = mock(HttpServletRequest.class);
        var response = mock(HttpServletResponse.class);
        var chain = mock(FilterChain.class);
        when(request.getHeader("Authorization")).thenReturn("Bearer valid-jwt");
        when(jwtProvider.validateToken("valid-jwt")).thenReturn(true);
        when(jwtProvider.getUserIdFromToken("valid-jwt")).thenReturn(USER_ID);
        when(jwtProvider.getTokenVersionFromToken("valid-jwt")).thenReturn(3);
        when(userRepository.findById(java.util.UUID.fromString(USER_ID)))
                .thenReturn(java.util.Optional.of(userWithVersion(3)));

        filter.doFilterInternal(request, response, chain);

        var auth = SecurityContextHolder.getContext().getAuthentication();
        assertNotNull(auth);
        assertEquals(USER_ID, auth.getPrincipal());
        // PLAN-0610 W3-2b: the legacy ROLE_<claim role> authority is retired; only cap:* carries
        // authorization (this fixture's AuthzContext stub grants nothing).
        assertFalse(auth.getAuthorities().stream()
            .anyMatch(a -> a.getAuthority().startsWith("ROLE_")),
            "no ROLE_ compatibility authority may be injected: " + auth.getAuthorities());
    }

    private static User userWithVersion(int tokenVersion) {
        User user = new User("user@test.com", "hash", UserRole.USER, "User", "user");
        user.setId(java.util.UUID.fromString(USER_ID));
        user.setTokenVersion(tokenVersion);
        return user;
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

