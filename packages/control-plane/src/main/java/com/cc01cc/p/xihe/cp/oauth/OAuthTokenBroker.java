package com.cc01cc.p.xihe.cp.oauth;

import java.util.concurrent.CancellationException;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicLong;
import java.util.function.LongSupplier;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.slf4j.MDC;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.dao.CannotAcquireLockException;
import org.springframework.stereotype.Component;

import com.cc01cc.p.xihe.cp.logging.RequestIdFilter;

/**
 * PLAN-0349: process-local access-token broker in front of
 * {@link OAuthCredentialService}. Keeps one cached access token per
 * {@code (userId, workspaceId, serverId)}, merges concurrent same-key
 * refreshes into a single provider round trip (single-flight), and never
 * writes a refresh result into the cache once the credential has been revoked
 * (per-key revocation epoch, decision #13).
 *
 * <p>Single CP instance assumption (decision #6); multi-instance consistency
 * is recorded as design risk #3.
 *
 * <p>Observability (decision #10) uses structured SLF4J events only. Token
 * material and provider response bodies are never logged.
 */
@Component
public class OAuthTokenBroker {

    /** Frozen TTL ceiling for the process-local cache (decision #5/#13). */
    static final long DEFAULT_TTL_SECONDS = 300;
    /** Frozen safety margin subtracted from {@code expires_in} (decision #13). */
    static final long SKEW_SECONDS = 60;

    private static final Logger logger = LoggerFactory.getLogger(OAuthTokenBroker.class);

    private final OAuthCredentialService service;
    private final LongSupplier clock;
    private final ConcurrentHashMap<String, CachedToken> cache = new ConcurrentHashMap<>();
    private final ConcurrentHashMap<String, Flight> flights = new ConcurrentHashMap<>();
    private final ConcurrentHashMap<String, AtomicLong> revocationEpochs = new ConcurrentHashMap<>();

    @Autowired
    public OAuthTokenBroker(OAuthCredentialService service) {
        this(service, System::currentTimeMillis);
    }

    OAuthTokenBroker(OAuthCredentialService service, LongSupplier clock) {
        this.service = service;
        this.clock = clock;
    }

    /**
     * Returns a usable access token for the triple, serving from cache when
     * possible and otherwise coordinating a single provider refresh per key.
     */
    public OAuthCredentialService.AccessGrant getAccessToken(
            String userId, String workspaceId, String serverId, String requestedScope) {
        if (requestedScope == null || requestedScope.isBlank()) {
            throw new OAuthBrokerException(OAuthBrokerException.Kind.REAUTH_REQUIRED, "scope_required");
        }
        String key = key(userId, workspaceId, serverId);
        long now = clock.getAsLong();
        CachedToken cached = cache.get(key);
        if (cached != null) {
            if (now < cached.expiresAtMillis() && requestedScope.equals(cached.scope())) {
                logEvent("oauth_token_hit", userId, workspaceId, serverId,
                        "result=hit remainingSeconds=" + Math.max(0, (cached.expiresAtMillis() - now) / 1000));
                return cached.grant();
            }
            cache.remove(key, cached);
            if (now < cached.expiresAtMillis()) {
                logFailure(userId, workspaceId, serverId, "reauth", "scope_mismatch", 0);
                throw new OAuthBrokerException(OAuthBrokerException.Kind.REAUTH_REQUIRED, "scope_mismatch");
            }
        }

        Flight flight = new Flight();
        Flight leader = flights.putIfAbsent(key, flight);
        if (leader != null) {
            logEvent("oauth_token_merge", userId, workspaceId, serverId, "result=merged");
            return awaitFlight(leader, userId, workspaceId, serverId);
        }

        long epochAtStart = epochOf(key);
        long startedAt = clock.getAsLong();
        try {
            logEvent("oauth_token_miss", userId, workspaceId, serverId, "result=refresh");
            OAuthCredentialService.RefreshResult result =
                    service.refreshLocked(userId, workspaceId, serverId, requestedScope);
            long ttlSeconds = ttlSeconds(result.expiresInSeconds());
            long responseExpiresIn = result.expiresInSeconds() == null
                    ? DEFAULT_TTL_SECONDS : result.expiresInSeconds();
            OAuthCredentialService.AccessGrant grant = new OAuthCredentialService.AccessGrant(
                    result.accessToken(), responseExpiresIn, result.scope());
            if (ttlSeconds > 0 && epochOf(key) == epochAtStart) {
                cache.put(key, new CachedToken(grant, clock.getAsLong() + ttlSeconds * 1000, result.scope()));
                logEvent("oauth_token_refresh", userId, workspaceId, serverId,
                        "result=refreshed cacheTtlSeconds=" + ttlSeconds
                                + " elapsedMs=" + (clock.getAsLong() - startedAt));
            } else if (ttlSeconds > 0) {
                logEvent("oauth_token_refresh", userId, workspaceId, serverId,
                        "result=refreshed cacheTtlSeconds=0 reason=revoked_during_refresh"
                                + " elapsedMs=" + (clock.getAsLong() - startedAt));
            } else {
                logEvent("oauth_token_refresh", userId, workspaceId, serverId,
                        "result=refreshed cacheTtlSeconds=0 reason=expires_in_below_skew"
                                + " elapsedMs=" + (clock.getAsLong() - startedAt));
            }
            flight.result.complete(grant);
            return grant;
        } catch (RuntimeException failure) {
            flight.result.completeExceptionally(failure);
            logFailure(userId, workspaceId, serverId, classify(failure), failure.getMessage(),
                    clock.getAsLong() - startedAt);
            throw failure;
        } finally {
            flights.remove(key, flight);
        }
    }

    /**
     * Drops any cached token for the triple and advances its revocation epoch
     * so that a refresh already in progress cannot repopulate the cache.
     * Called by {@link OAuthCredentialService} after revoke (and on freshly
     * completed authorization).
     */
    void invalidate(String userId, String workspaceId, String serverId) {
        String key = key(userId, workspaceId, serverId);
        revocationEpochs.computeIfAbsent(key, ignored -> new AtomicLong()).incrementAndGet();
        cache.remove(key);
    }

    private OAuthCredentialService.AccessGrant awaitFlight(
            Flight flight, String userId, String workspaceId, String serverId) {
        try {
            return flight.result.join();
        } catch (CancellationException e) {
            throw new OAuthBrokerException(OAuthBrokerException.Kind.TOKEN_UNAVAILABLE,
                    "OAuth refresh was cancelled", e);
        } catch (CompletionException e) {
            Throwable cause = e.getCause() == null ? e : e.getCause();
            if (cause instanceof RuntimeException runtime) {
                throw runtime;
            }
            throw new OAuthBrokerException(OAuthBrokerException.Kind.TOKEN_UNAVAILABLE,
                    "OAuth refresh failed", cause);
        }
    }

    private long epochOf(String key) {
        AtomicLong counter = revocationEpochs.get(key);
        return counter == null ? 0 : counter.get();
    }

    private static String key(String userId, String workspaceId, String serverId) {
        return userId + ":" + workspaceId + ":" + serverId;
    }

    /**
     * Frozen TTL rule (decision #13): {@code clamp(expires_in - 60, 0, 300)};
     * a missing {@code expires_in} uses the conservative 300s default; a
     * clamped-to-zero result means "return the token but do not cache it".
     */
    static long ttlSeconds(Long expiresInSeconds) {
        if (expiresInSeconds == null) {
            return DEFAULT_TTL_SECONDS;
        }
        long effective = expiresInSeconds - SKEW_SECONDS;
        if (effective <= 0) {
            return 0;
        }
        return Math.min(effective, DEFAULT_TTL_SECONDS);
    }

    private static String classify(RuntimeException failure) {
        if (failure instanceof OAuthBrokerException brokerFailure) {
            return brokerFailure.kind() == OAuthBrokerException.Kind.REAUTH_REQUIRED ? "reauth" : "unavailable";
        }
        if (failure instanceof CannotAcquireLockException) {
            return "lock_timeout";
        }
        return "unexpected";
    }

    private void logEvent(String event, String userId, String workspaceId, String serverId, String fields) {
        logger.info("service=cp event={} userId={} workspaceId={} serverId={} requestId={} {}",
                event, userId, workspaceId, serverId, requestId(), fields);
    }

    private void logFailure(String userId, String workspaceId, String serverId,
                            String errorKind, String reason, long elapsedMs) {
        logger.warn("service=cp event=oauth_token_failure userId={} workspaceId={} serverId={} "
                        + "requestId={} errorKind={} reason={} elapsedMs={}",
                userId, workspaceId, serverId, requestId(), errorKind, reason, elapsedMs);
    }

    private static String requestId() {
        String requestId = MDC.get(RequestIdFilter.MDC_KEY);
        return requestId == null ? "-" : requestId;
    }

    private record CachedToken(OAuthCredentialService.AccessGrant grant, long expiresAtMillis, String scope) {}

    private static final class Flight {
        private final CompletableFuture<OAuthCredentialService.AccessGrant> result = new CompletableFuture<>();
    }
}
