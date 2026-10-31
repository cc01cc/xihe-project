package com.cc01cc.p.xihe.cp.config;

import io.jsonwebtoken.Claims;
import io.jsonwebtoken.JwtException;
import io.jsonwebtoken.Jwts;
import io.jsonwebtoken.security.Keys;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import javax.crypto.SecretKey;
import java.nio.charset.StandardCharsets;
import java.util.Date;

@Component
public class JwtTokenProvider {

    private static final Logger logger = LoggerFactory.getLogger(JwtTokenProvider.class);

    /** PLAN-0580: access-token epoch claim name (matches {@code users.token_version}). */
    public static final String TOKEN_VERSION_CLAIM = "tv";

    private final SecretKey accessKey;
    private final SecretKey refreshKey;
    private final long accessTokenValidity;
    private final long refreshTokenValidity;

    public JwtTokenProvider(
            @Value("${cp.jwt.secret:xihe-cp-jwt-secret-key-change-in-production}") String secret,
            @Value("${cp.jwt.access-token-validity-seconds:900}") long accessTokenValiditySeconds,
            @Value("${cp.jwt.refresh-token-validity-seconds:604800}") long refreshTokenValiditySeconds) {
        this.accessKey = Keys.hmacShaKeyFor(secret.getBytes(StandardCharsets.UTF_8));
        this.refreshKey = Keys.hmacShaKeyFor((secret + "-refresh").getBytes(StandardCharsets.UTF_8));
        this.accessTokenValidity = accessTokenValiditySeconds * 1000L;
        this.refreshTokenValidity = refreshTokenValiditySeconds * 1000L;
    }

    /**
     * PLAN-0559: production access tokens are user-level. The workspace is
     * resolved per request from {@code X-Workspace-Id} (or the legacy claim /
     * default workspace during the transition), so a token can never pin a
     * browser tab to one workspace.
     *
     * <p>PLAN-0580: every access token carries the epoch claim {@code tv} — the
     * value of {@code users.token_version} at issue time. The single production
     * issue point is {@code AuthService.issueTokens}; a token without {@code tv}
     * is rejected by {@link AccessTokenAuthenticator} (decision #14).
     */
    public String createAccessToken(String userId, String email, String role, int tokenVersion) {
        return createAccessToken(userId, email, role, null, tokenVersion);
    }

    /**
     * Legacy/test-only overload. Passing a workspaceId keeps the old
     * {@code workspace_id} claim so PLAN-0559 can exercise the transition and
     * older client shapes; production code must call the four-argument form.
     */
    public String createAccessToken(String userId, String email, String role, String workspaceId,
                                    int tokenVersion) {
        Date now = new Date();
        Date expiry = new Date(now.getTime() + accessTokenValidity);

        io.jsonwebtoken.JwtBuilder builder = Jwts.builder()
                .subject(userId)
                .claim("email", email)
                .claim("role", role)
                .claim(TOKEN_VERSION_CLAIM, tokenVersion)
                .issuedAt(now)
                .expiration(expiry);
        if (workspaceId != null && !workspaceId.isBlank()) {
            builder.claim("workspace_id", workspaceId);
        }
        return builder.signWith(accessKey).compact();
    }

    public String createRefreshToken(String userId) {
        Date now = new Date();
        Date expiry = new Date(now.getTime() + refreshTokenValidity);

        return Jwts.builder()
                .subject(userId)
                .claim("type", "refresh")
                .issuedAt(now)
                .expiration(expiry)
                .signWith(refreshKey)
                .compact();
    }

    public boolean validateToken(String token) {
        try {
            Jwts.parser()
                    .verifyWith(accessKey)
                    .build()
                    .parseSignedClaims(token);
            return true;
        } catch (JwtException | IllegalArgumentException e) {
            if (logger.isDebugEnabled()) {
                logger.debug("JWT access token validation failed: {}", e.getMessage());
            }
            return false;
        }
    }

    public boolean validateRefreshToken(String token) {
        try {
            Claims claims = Jwts.parser()
                    .verifyWith(refreshKey)
                    .build()
                    .parseSignedClaims(token)
                    .getPayload();
            return "refresh".equals(claims.get("type"));
        } catch (JwtException | IllegalArgumentException e) {
            if (logger.isDebugEnabled()) {
                logger.debug("JWT refresh token validation failed: {}", e.getMessage());
            }
            return false;
        }
    }

    public String getUserIdFromToken(String token) {
        return Jwts.parser()
                .verifyWith(accessKey)
                .build()
                .parseSignedClaims(token)
                .getPayload()
                .getSubject();
    }

    public String getUserIdFromRefreshToken(String token) {
        return Jwts.parser()
                .verifyWith(refreshKey)
                .build()
                .parseSignedClaims(token)
                .getPayload()
                .getSubject();
    }

    public String getEmailFromToken(String token) {
        return Jwts.parser()
                .verifyWith(accessKey)
                .build()
                .parseSignedClaims(token)
                .getPayload()
                .get("email", String.class);
    }

    public String getRoleFromToken(String token) {
        return Jwts.parser()
                .verifyWith(accessKey)
                .build()
                .parseSignedClaims(token)
                .getPayload()
                .get("role", String.class);
    }

    public String getWorkspaceIdFromToken(String token) {
        return Jwts.parser()
                .verifyWith(accessKey)
                .build()
                .parseSignedClaims(token)
                .getPayload()
                .get("workspace_id", String.class);
    }

    /**
     * PLAN-0580: the {@code tv} claim, or {@code null} when the token predates
     * the epoch (or carries a non-numeric value). A null result is a hard
     * rejection — see {@link AccessTokenAuthenticator}.
     */
    public Integer getTokenVersionFromToken(String token) {
        Object raw = Jwts.parser()
                .verifyWith(accessKey)
                .build()
                .parseSignedClaims(token)
                .getPayload()
                .get(TOKEN_VERSION_CLAIM);
        if (raw instanceof Number number) {
            return number.intValue();
        }
        return null;
    }
}
