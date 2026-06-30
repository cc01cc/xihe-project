package com.cc01cc.p.xihe.cp.config;

import io.jsonwebtoken.*;
import io.jsonwebtoken.security.Keys;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import javax.crypto.SecretKey;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.Date;

@Component
public class JwtTokenProvider {

    private static final Logger logger = LoggerFactory.getLogger(JwtTokenProvider.class);

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

    public String createAccessToken(String userId, String email, String role, String workspaceId) {
        Date now = new Date();
        Date expiry = new Date(now.getTime() + accessTokenValidity);

        return Jwts.builder()
                .subject(userId)
                .claim("email", email)
                .claim("role", role)
                .claim("workspace_id", workspaceId)
                .issuedAt(now)
                .expiration(expiry)
                .signWith(accessKey)
                .compact();
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
}
