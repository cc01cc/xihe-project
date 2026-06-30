package com.cc01cc.p.xihe.cp.config;

import io.jsonwebtoken.Jwts;
import io.jsonwebtoken.security.Keys;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import javax.crypto.SecretKey;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.Base64;
import java.util.Date;

import static org.junit.jupiter.api.Assertions.*;

class JwtTokenProviderTest {

    private static final String SECRET = "test-jwt-secret-key-for-testing-purposes";
    private static final long ACCESS_VALIDITY_SECONDS = 900;
    private static final long REFRESH_VALIDITY_SECONDS = 604800;

    private JwtTokenProvider provider;

    @BeforeEach
    void setUp() {
        provider = new JwtTokenProvider(SECRET, ACCESS_VALIDITY_SECONDS, REFRESH_VALIDITY_SECONDS);
    }

    @Test
    void generateTokenReturnsValidJwt() {
        String token = provider.createAccessToken("user-1", "test@test.com", "USER", "workspace-1");

        assertNotNull(token);
        assertEquals(3, token.split("\\.").length);
        assertTrue(provider.validateToken(token));
    }

    @Test
    void generateTokenHandlesNullWorkspaceId() {
        String token = provider.createAccessToken("user-1", "test@test.com", "USER", null);

        assertNotNull(token);
        assertTrue(provider.validateToken(token));
    }

    @Test
    void getUserIdFromTokenExtractsCorrectId() {
        String token = provider.createAccessToken("user-42", "test@test.com", "USER", null);

        assertEquals("user-42", provider.getUserIdFromToken(token));
    }

    @Test
    void getEmailFromTokenExtractsCorrectEmail() {
        String token = provider.createAccessToken("user-1", "someone@example.com", "USER", null);

        assertEquals("someone@example.com", provider.getEmailFromToken(token));
    }

    @Test
    void getRoleFromTokenExtractsCorrectRole() {
        String token = provider.createAccessToken("user-1", "test@test.com", "ADMIN", null);

        assertEquals("ADMIN", provider.getRoleFromToken(token));
    }

    @Test
    void getWorkspaceIdFromTokenExtractsCorrectWorkspace() {
        String token = provider.createAccessToken("user-1", "test@test.com", "USER", "ws-xyz");

        assertEquals("ws-xyz", provider.getWorkspaceIdFromToken(token));
    }

    @Test
    void validateTokenRejectsExpiredToken() {
        SecretKey key = Keys.hmacShaKeyFor(SECRET.getBytes(StandardCharsets.UTF_8));
        String expiredToken = Jwts.builder()
                .subject("user-1")
                .expiration(Date.from(Instant.now().minus(1, ChronoUnit.HOURS)))
                .signWith(key)
                .compact();

        assertFalse(provider.validateToken(expiredToken));
    }

    @Test
    void validateTokenRejectsTamperedToken() {
        String validToken = provider.createAccessToken("user-1", "test@test.com", "USER", null);
        String[] parts = validToken.split("\\.");
        String tamperedPayload = Base64.getUrlEncoder().withoutPadding()
                .encodeToString("{\"sub\":\"attacker\"}".getBytes(StandardCharsets.UTF_8));
        String tamperedToken = parts[0] + "." + tamperedPayload + "." + parts[2];

        assertFalse(provider.validateToken(tamperedToken));
    }

    @Test
    void validateTokenRejectsNullAndEmpty() {
        assertFalse(provider.validateToken(null));
        assertFalse(provider.validateToken(""));
        assertFalse(provider.validateToken("invalid.token.here"));
    }

    @Test
    void validateTokenRejectsRefreshToken() {
        String refreshToken = provider.createRefreshToken("user-1");

        assertFalse(provider.validateToken(refreshToken));
    }

    @Test
    void createRefreshTokenReturnsValidRefreshToken() {
        String refreshToken = provider.createRefreshToken("user-1");

        assertNotNull(refreshToken);
        assertEquals(3, refreshToken.split("\\.").length);
    }

    @Test
    void validateRefreshTokenAcceptsValidRefreshToken() {
        String refreshToken = provider.createRefreshToken("user-1");

        assertTrue(provider.validateRefreshToken(refreshToken));
    }

    @Test
    void validateRefreshTokenRejectsAccessToken() {
        String accessToken = provider.createAccessToken("user-1", "test@test.com", "USER", null);

        assertFalse(provider.validateRefreshToken(accessToken));
    }

    @Test
    void getUserIdFromRefreshTokenExtractsCorrectId() {
        String refreshToken = provider.createRefreshToken("user-99");

        assertEquals("user-99", provider.getUserIdFromRefreshToken(refreshToken));
    }

    @Test
    void refreshTokenGeneratesNewTokenPair() {
        String refreshToken = provider.createRefreshToken("user-1");

        assertTrue(provider.validateRefreshToken(refreshToken));
        assertEquals("user-1", provider.getUserIdFromRefreshToken(refreshToken));

        String newAccessToken = provider.createAccessToken("user-1", "test@test.com", "USER", null);
        assertTrue(provider.validateToken(newAccessToken));
        assertEquals("user-1", provider.getUserIdFromToken(newAccessToken));
    }
}
