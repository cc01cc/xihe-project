package com.cc01cc.p.xihe.cp.auth;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import com.cc01cc.p.xihe.cp.config.AccessTokenAuthenticator;
import com.cc01cc.p.xihe.cp.config.JwtTokenProvider;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.entity.UserRole;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import java.util.Optional;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

/**
 * PLAN-0580 decision #14: the three fail-closed states must be plain
 * "no authentication" (→ 401), never an exception that would surface as 500.
 */
class AccessTokenAuthenticatorTest {

    private static final String TOKEN = "token";
    private static final UUID USER_ID = UUID.fromString("11111111-1111-4111-8111-111111111111");

    private JwtTokenProvider jwtTokenProvider;
    private UserRepository userRepository;
    private AccessTokenAuthenticator authenticator;

    @BeforeEach
    void setUp() {
        jwtTokenProvider = mock(JwtTokenProvider.class);
        userRepository = mock(UserRepository.class);
        authenticator = new AccessTokenAuthenticator(jwtTokenProvider, userRepository);
        when(jwtTokenProvider.validateToken(TOKEN)).thenReturn(true);
        when(jwtTokenProvider.getRoleFromToken(TOKEN)).thenReturn("ADMIN");
    }

    private static User persistedUser(int tokenVersion) {
        User user = new User("owner@test.com", "hash", UserRole.ADMIN, "Owner", "owner");
        user.setId(USER_ID);
        user.setTokenVersion(tokenVersion);
        return user;
    }

    @Test
    void matchingEpochAuthenticates() {
        when(jwtTokenProvider.getUserIdFromToken(TOKEN)).thenReturn(USER_ID.toString());
        when(jwtTokenProvider.getTokenVersionFromToken(TOKEN)).thenReturn(2);
        when(userRepository.findById(USER_ID)).thenReturn(Optional.of(persistedUser(2)));

        Optional<AccessTokenAuthenticator.AuthenticatedUser> result = authenticator.authenticate(TOKEN);

        assertTrue(result.isPresent());
        assertEquals(USER_ID.toString(), result.get().userId());
        assertEquals("ADMIN", result.get().role());
        assertEquals(2, result.get().tokenVersion());
    }

    @Test
    void invalidSignatureIsRejected() {
        when(jwtTokenProvider.validateToken(TOKEN)).thenReturn(false);

        assertTrue(authenticator.authenticate(TOKEN).isEmpty());
    }

    /** T1: {@code sub} is not a UUID — {@code UUID.fromString} must not throw out of the filter. */
    @Test
    void nonUuidSubjectIsRejectedWithoutThrowing() {
        when(jwtTokenProvider.getUserIdFromToken(TOKEN)).thenReturn("internal-service");

        assertFalse(authenticator.authenticate(TOKEN).isPresent());
    }

    /** T2: valid UUID subject but no user row (deleted / never persisted). */
    @Test
    void unknownUserRowIsRejected() {
        when(jwtTokenProvider.getUserIdFromToken(TOKEN)).thenReturn(USER_ID.toString());
        when(userRepository.findById(USER_ID)).thenReturn(Optional.empty());

        assertFalse(authenticator.authenticate(TOKEN).isPresent());
    }

    /** T3a: the token predates the epoch claim — releasing it would be a permanent bypass. */
    @Test
    void missingTokenVersionClaimIsRejected() {
        when(jwtTokenProvider.getUserIdFromToken(TOKEN)).thenReturn(USER_ID.toString());
        when(jwtTokenProvider.getTokenVersionFromToken(TOKEN)).thenReturn(null);
        when(userRepository.findById(USER_ID)).thenReturn(Optional.of(persistedUser(0)));

        assertFalse(authenticator.authenticate(TOKEN).isPresent());
    }

    /** T3b: the epoch moved on (a role change bumped it) — the old token dies. */
    @Test
    void staleTokenVersionIsRejected() {
        when(jwtTokenProvider.getUserIdFromToken(TOKEN)).thenReturn(USER_ID.toString());
        when(jwtTokenProvider.getTokenVersionFromToken(TOKEN)).thenReturn(0);
        when(userRepository.findById(USER_ID)).thenReturn(Optional.of(persistedUser(1)));

        assertFalse(authenticator.authenticate(TOKEN).isPresent());
    }

    /** A blank/absent header never queries the database. */
    @Test
    void missingTokenIsRejected() {
        assertTrue(authenticator.authenticate(null).isEmpty());
        assertTrue(authenticator.authenticate("  ").isEmpty());
        org.mockito.Mockito.verify(userRepository, org.mockito.Mockito.never()).findById(any(UUID.class));
        org.mockito.Mockito.verify(jwtTokenProvider, org.mockito.Mockito.never()).getUserIdFromToken(anyString());
    }
}
