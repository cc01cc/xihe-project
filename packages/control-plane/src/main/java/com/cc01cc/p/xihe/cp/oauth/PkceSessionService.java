package com.cc01cc.p.xihe.cp.oauth;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.SecureRandom;
import java.util.Base64;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

import org.springframework.stereotype.Service;

/** Owns the short-lived, one-time state used by an OAuth PKCE flow. */
@Service
public class PkceSessionService {

    private static final int VERIFIER_BYTES = 32;
    private static final long SESSION_TTL_MILLIS = 10 * 60 * 1000L;

    private final SecureRandom random = new SecureRandom();
    private final Map<String, PendingSession> sessions = new ConcurrentHashMap<>();

    public PendingSession start(
            String userId,
            String workspaceId,
            String serverId,
            String clientId,
            String authorizationEndpoint,
            String tokenEndpoint,
            String redirectUri,
            String scope) {
        requireNonBlank(userId, "userId");
        requireNonBlank(workspaceId, "workspaceId");
        requireNonBlank(serverId, "serverId");
        requireNonBlank(clientId, "clientId");
        requireNonBlank(authorizationEndpoint, "authorizationEndpoint");
        requireNonBlank(tokenEndpoint, "tokenEndpoint");
        requireNonBlank(redirectUri, "redirectUri");
        requireNonBlank(scope, "scope");

        String verifier = randomUrlValue(VERIFIER_BYTES);
        PendingSession session = new PendingSession(
                UUID.randomUUID().toString(),
                userId,
                workspaceId,
                serverId,
                clientId,
                authorizationEndpoint,
                tokenEndpoint,
                redirectUri,
                scope,
                verifier,
                challenge(verifier),
                System.currentTimeMillis() + SESSION_TTL_MILLIS);
        sessions.put(session.state(), session);
        return session;
    }

    /** Atomically consumes a state and verifies its tenant binding. */
    public PendingSession consume(
            String state,
            String userId,
            String workspaceId,
            String serverId,
            String redirectUri) {
        PendingSession session = sessions.remove(state);
        if (session == null || session.expiresAtMillis() < System.currentTimeMillis()) {
            throw new IllegalArgumentException("OAuth state is invalid or expired");
        }
        if (!session.userId().equals(userId)
                || !session.workspaceId().equals(workspaceId)
                || !session.serverId().equals(serverId)
                || !session.redirectUri().equals(redirectUri)) {
            throw new IllegalArgumentException("OAuth state binding mismatch");
        }
        return session;
    }

    /** Consumes a callback state after the opaque state has authenticated the flow. */
    public PendingSession consume(String state) {
        PendingSession session = sessions.remove(state);
        if (session == null || session.expiresAtMillis() < System.currentTimeMillis()) {
            throw new IllegalArgumentException("OAuth state is invalid or expired");
        }
        return session;
    }

    public static String challenge(String verifier) {
        requireNonBlank(verifier, "codeVerifier");
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256")
                    .digest(verifier.getBytes(StandardCharsets.US_ASCII));
            return Base64.getUrlEncoder().withoutPadding().encodeToString(digest);
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("SHA-256 is unavailable", e);
        }
    }

    private String randomUrlValue(int byteCount) {
        byte[] bytes = new byte[byteCount];
        random.nextBytes(bytes);
        return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
    }

    private static void requireNonBlank(String value, String name) {
        if (value == null || value.isBlank()) {
            throw new IllegalArgumentException(name + " must not be blank");
        }
    }

    public record PendingSession(
            String state,
            String userId,
            String workspaceId,
            String serverId,
            String clientId,
            String authorizationEndpoint,
            String tokenEndpoint,
            String redirectUri,
            String scope,
            String codeVerifier,
            String codeChallenge,
            long expiresAtMillis) {
    }
}
