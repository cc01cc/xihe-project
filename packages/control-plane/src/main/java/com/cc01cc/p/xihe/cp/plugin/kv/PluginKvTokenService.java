package com.cc01cc.p.xihe.cp.plugin.kv;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import io.jsonwebtoken.Claims;
import io.jsonwebtoken.JwtException;
import io.jsonwebtoken.Jwts;
import io.jsonwebtoken.security.Keys;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Component;

import javax.crypto.SecretKey;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.Date;
import java.util.UUID;

/**
 * PLAN-0691 T1.5: issues and verifies the binding-scoped KV service token (spec/data-plane.md SEC-1).
 *
 * <p>Claims are exactly {@code binding_id / plugin_id / digest / scope / exp} and the TTL is fixed at
 * {@value #TTL_SECONDS} seconds — SEC-1 freezes both, so there is no property for them. A 300 s TTL
 * is what makes SEC-2's "binding is no longer enabled" check cheap: a plugin cannot keep writing for
 * longer than five minutes after a suspend even if it never calls back.
 *
 * <p>The signing key is derived from {@code cp.jwt.secret} with a {@code -plugin-kv} suffix, i.e. the
 * same pattern {@code JwtTokenProvider} uses for its refresh key ({@code -refresh}). One secret,
 * three disjoint keys: a KV token can never be replayed as a user access token or vice versa, because
 * the key differs, not the claim shape.
 *
 * <p>M1 has no issuer endpoint yet: the token is minted by the CP-side caller that hands a plugin its
 * credential (T1.4/lane A). This class deliberately exposes {@link #issue} publicly so that lane can
 * reuse it instead of copying the key derivation.
 */
@Component
public class PluginKvTokenService {

    /** SEC-1: fixed TTL, not configurable. */
    public static final long TTL_SECONDS = 300;

    /** SEC-1 claim names. */
    public static final String CLAIM_BINDING_ID = "binding_id";
    public static final String CLAIM_PLUGIN_ID = "plugin_id";
    public static final String CLAIM_DIGEST = "digest";
    public static final String CLAIM_SCOPE = "scope";

    private static final String KEY_SUFFIX = "-plugin-kv";

    private final SecretKey key;

    public PluginKvTokenService(
            @Value("${cp.jwt.secret:xihe-cp-jwt-secret-key-change-in-production}") String secret) {
        this.key = Keys.hmacShaKeyFor((secret + KEY_SUFFIX).getBytes(StandardCharsets.UTF_8));
    }

    /** Issues a token valid for {@value #TTL_SECONDS} seconds from now. */
    public String issue(UUID bindingId, String pluginId, String digest, String scope) {
        return issue(bindingId, pluginId, digest, scope, Instant.now());
    }

    /**
     * Issues a token whose {@code exp} is {@code issuedAt + 300 s}.
     *
     * <p>Package-private on purpose: it exists so the negative tests can mint an already-expired
     * token without patching the clock of the application context, and it keeps the TTL arithmetic in
     * one place instead of letting a test re-derive the signing key.
     */
    String issue(UUID bindingId, String pluginId, String digest, String scope, Instant issuedAt) {
        Instant issued = issuedAt == null ? Instant.now() : issuedAt;
        return Jwts.builder()
                .subject(bindingId.toString())
                .claim(CLAIM_BINDING_ID, bindingId.toString())
                .claim(CLAIM_PLUGIN_ID, pluginId)
                .claim(CLAIM_DIGEST, digest)
                .claim(CLAIM_SCOPE, scope)
                .issuedAt(Date.from(issued))
                .expiration(Date.from(issued.plusSeconds(TTL_SECONDS)))
                .signWith(key)
                .compact();
    }

    /**
     * Verifies signature and expiry and returns the SEC-1 claims.
     *
     * <p>Errors are 401 {@code AUTHORIZATION_REQUIRED}, the CP-wide "not authenticated" contract; a
     * 403 here would tell an unauthenticated caller that the path exists and the token was merely
     * insufficient, which is the wrong side of SEC-2's "no existence leak".
     *
     * @throws CpApiException 401 when the token is missing claims, malformed or expired
     */
    PluginKvClaims verify(String token) {
        Claims claims;
        try {
            claims = Jwts.parser().verifyWith(key).build().parseSignedClaims(token).getPayload();
        } catch (JwtException | IllegalArgumentException e) {
            throw unauthenticated("binding token rejected: " + e.getClass().getSimpleName());
        }
        Date expiration = claims.getExpiration();
        if (expiration == null) {
            throw unauthenticated("binding token has no exp claim");
        }
        try {
            return new PluginKvClaims(
                    UUID.fromString(requireString(claims, CLAIM_BINDING_ID)),
                    requireString(claims, CLAIM_PLUGIN_ID),
                    requireString(claims, CLAIM_DIGEST),
                    claims.get(CLAIM_SCOPE, String.class),
                    expiration.toInstant());
        } catch (IllegalArgumentException e) {
            // UUID.fromString and requireString fail with IllegalArgumentException; the message names
            // a claim, never the token, so it is safe to surface.
            throw unauthenticated("binding token claims invalid: " + e.getMessage());
        }
    }

    private static String requireString(Claims claims, String name) {
        String value = claims.get(name, String.class);
        if (value == null || value.isBlank()) {
            throw new IllegalArgumentException("missing claim " + name);
        }
        return value;
    }

    private static CpApiException unauthenticated(String detail) {
        return new CpApiException(HttpStatus.UNAUTHORIZED, "AUTHORIZATION_REQUIRED", detail);
    }
}
