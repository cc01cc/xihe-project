package com.cc01cc.p.xihe.cp.oauth;

import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicReference;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * PLAN-0349 broker unit tests: TTL policy, cache hits, single-flight merge and
 * failure propagation, and the revocation-epoch guard. Uses a manual clock so
 * expiry is exercised without sleeping (project-wide no-sleep rule).
 */
class OAuthTokenBrokerTest {

    private static final String USER = "user-1";
    private static final String WORKSPACE = "workspace-1";
    private static final String SERVER = "server-1";
    private static final String SCOPE = "mcp:tools";

    private final OAuthCredentialService service = mock(OAuthCredentialService.class);
    private final AtomicLong now = new AtomicLong(1_000_000L);

    private OAuthTokenBroker broker() {
        return new OAuthTokenBroker(service, now::get);
    }

    private static OAuthCredentialService.RefreshResult result(String token, Long expiresIn) {
        return new OAuthCredentialService.RefreshResult(token, expiresIn, SCOPE);
    }

    @Test
    void ttlPolicyMatchesTheFrozenClamp() {
        assertEquals(300, OAuthTokenBroker.ttlSeconds(null));
        assertEquals(300, OAuthTokenBroker.ttlSeconds(3600L));
        assertEquals(240, OAuthTokenBroker.ttlSeconds(300L));
        assertEquals(90, OAuthTokenBroker.ttlSeconds(150L));
        assertEquals(1, OAuthTokenBroker.ttlSeconds(61L));
        assertEquals(0, OAuthTokenBroker.ttlSeconds(60L));
        assertEquals(0, OAuthTokenBroker.ttlSeconds(1L));
    }

    @Test
    void cacheHitAvoidsASecondProviderRefresh() {
        when(service.refreshLocked(USER, WORKSPACE, SERVER, SCOPE)).thenReturn(result("access-1", 300L));
        OAuthTokenBroker broker = broker();

        OAuthCredentialService.AccessGrant first = broker.getAccessToken(USER, WORKSPACE, SERVER, SCOPE);
        OAuthCredentialService.AccessGrant second = broker.getAccessToken(USER, WORKSPACE, SERVER, SCOPE);

        assertEquals("access-1", first.accessToken());
        assertEquals("access-1", second.accessToken());
        assertEquals(300, first.expiresIn());
        verify(service, times(1)).refreshLocked(USER, WORKSPACE, SERVER, SCOPE);
    }

    @Test
    void expiryUsesTheTtlClampAndRefreshesAfterIt() {
        when(service.refreshLocked(USER, WORKSPACE, SERVER, SCOPE))
                .thenReturn(result("access-1", 61L))
                .thenReturn(result("access-2", 61L));
        OAuthTokenBroker broker = broker();

        assertEquals("access-1", broker.getAccessToken(USER, WORKSPACE, SERVER, SCOPE).accessToken());
        now.addAndGet(900);
        assertEquals("access-1", broker.getAccessToken(USER, WORKSPACE, SERVER, SCOPE).accessToken());
        now.addAndGet(200);
        assertEquals("access-2", broker.getAccessToken(USER, WORKSPACE, SERVER, SCOPE).accessToken());
        verify(service, times(2)).refreshLocked(USER, WORKSPACE, SERVER, SCOPE);
    }

    @Test
    void missingExpiresInUsesTheConservativeDefault() {
        when(service.refreshLocked(USER, WORKSPACE, SERVER, SCOPE)).thenReturn(result("access-1", null));
        OAuthTokenBroker broker = broker();

        OAuthCredentialService.AccessGrant grant = broker.getAccessToken(USER, WORKSPACE, SERVER, SCOPE);
        assertEquals(300, grant.expiresIn(), "response keeps the 300s default");
        now.addAndGet(299_000);
        broker.getAccessToken(USER, WORKSPACE, SERVER, SCOPE);
        verify(service, times(1)).refreshLocked(USER, WORKSPACE, SERVER, SCOPE);
        now.addAndGet(2_000);
        broker.getAccessToken(USER, WORKSPACE, SERVER, SCOPE);
        verify(service, times(2)).refreshLocked(USER, WORKSPACE, SERVER, SCOPE);
    }

    @Test
    void expiresInAtOrBelowSkewIsReturnedButNotCached() {
        when(service.refreshLocked(USER, WORKSPACE, SERVER, SCOPE)).thenReturn(result("access-1", 60L));
        OAuthTokenBroker broker = broker();

        assertEquals(60, broker.getAccessToken(USER, WORKSPACE, SERVER, SCOPE).expiresIn());
        broker.getAccessToken(USER, WORKSPACE, SERVER, SCOPE);
        verify(service, times(2)).refreshLocked(USER, WORKSPACE, SERVER, SCOPE);
    }

    @Test
    void cachedScopeMismatchIsDeterministicReauthWithoutProviderCall() {
        when(service.refreshLocked(USER, WORKSPACE, SERVER, SCOPE)).thenReturn(result("access-1", 300L));
        OAuthTokenBroker broker = broker();
        broker.getAccessToken(USER, WORKSPACE, SERVER, SCOPE);

        OAuthBrokerException failure = assertThrows(OAuthBrokerException.class,
                () -> broker.getAccessToken(USER, WORKSPACE, SERVER, "other:scope"));
        assertEquals(OAuthBrokerException.Kind.REAUTH_REQUIRED, failure.kind());
        verify(service, times(1)).refreshLocked(USER, WORKSPACE, SERVER, SCOPE);
    }

    @Test
    void followersShareTheLeaderResult() throws Exception {
        CountDownLatch leaderInside = new CountDownLatch(1);
        AtomicReference<Thread> followerThread = new AtomicReference<>();
        when(service.refreshLocked(USER, WORKSPACE, SERVER, SCOPE)).thenAnswer(invocation -> {
            leaderInside.countDown();
            awaitFollowerParked(followerThread);
            return result("access-1", 300L);
        });
        OAuthTokenBroker broker = broker();

        ExecutorService pool = Executors.newFixedThreadPool(2);
        try {
            Future<OAuthCredentialService.AccessGrant> leader =
                    pool.submit(() -> broker.getAccessToken(USER, WORKSPACE, SERVER, SCOPE));
            assertTrue(leaderInside.await(5, TimeUnit.SECONDS));
            Future<OAuthCredentialService.AccessGrant> follower = pool.submit(() -> {
                followerThread.set(Thread.currentThread());
                return broker.getAccessToken(USER, WORKSPACE, SERVER, SCOPE);
            });
            assertEquals("access-1", leader.get(5, TimeUnit.SECONDS).accessToken());
            assertEquals("access-1", follower.get(5, TimeUnit.SECONDS).accessToken());
        } finally {
            pool.shutdownNow();
        }
        verify(service, times(1)).refreshLocked(USER, WORKSPACE, SERVER, SCOPE);
    }

    @Test
    void followersReceiveTheSameFailure() throws Exception {
        CountDownLatch leaderInside = new CountDownLatch(1);
        AtomicReference<Thread> followerThread = new AtomicReference<>();
        when(service.refreshLocked(USER, WORKSPACE, SERVER, SCOPE)).thenAnswer(invocation -> {
            leaderInside.countDown();
            awaitFollowerParked(followerThread);
            throw new OAuthBrokerException(OAuthBrokerException.Kind.TOKEN_UNAVAILABLE, "provider_unreachable");
        });
        OAuthTokenBroker broker = broker();

        ExecutorService pool = Executors.newFixedThreadPool(2);
        try {
            Future<OAuthBrokerException> leader = pool.submit(() -> assertThrows(OAuthBrokerException.class,
                    () -> broker.getAccessToken(USER, WORKSPACE, SERVER, SCOPE)));
            assertTrue(leaderInside.await(5, TimeUnit.SECONDS));
            Future<OAuthBrokerException> follower = pool.submit(() -> {
                followerThread.set(Thread.currentThread());
                return assertThrows(OAuthBrokerException.class,
                        () -> broker.getAccessToken(USER, WORKSPACE, SERVER, SCOPE));
            });
            assertEquals(OAuthBrokerException.Kind.TOKEN_UNAVAILABLE, leader.get(5, TimeUnit.SECONDS).kind());
            assertEquals(OAuthBrokerException.Kind.TOKEN_UNAVAILABLE, follower.get(5, TimeUnit.SECONDS).kind());
        } finally {
            pool.shutdownNow();
        }
        verify(service, times(1)).refreshLocked(USER, WORKSPACE, SERVER, SCOPE);
    }

    /**
     * Blocks the leader until the follower thread is parked inside the shared
     * flight (bounded wait; no fixed sleep). If the follower instead started a
     * second refresh, it never parks and the caller fails loudly.
     */
    private static void awaitFollowerParked(AtomicReference<Thread> followerThread) {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
        while (System.nanoTime() < deadline) {
            Thread thread = followerThread.get();
            if (thread != null && thread.getState() == Thread.State.WAITING) {
                return;
            }
            Thread.onSpinWait();
        }
        throw new IllegalStateException("follower did not park in the shared flight");
    }

    @Test
    void refreshResultIsDiscardedWhenTheCredentialIsRevokedMidFlight() {
        AtomicInteger refreshes = new AtomicInteger();
        OAuthTokenBroker broker = broker();
        when(service.refreshLocked(USER, WORKSPACE, SERVER, SCOPE)).thenAnswer(invocation -> {
            if (refreshes.getAndIncrement() == 0) {
                // Simulates a revoke landing after the refresh committed but before
                // its result reached the cache.
                broker.invalidate(USER, WORKSPACE, SERVER);
            }
            return result("access-" + refreshes.get(), 300L);
        });

        assertEquals("access-1", broker.getAccessToken(USER, WORKSPACE, SERVER, SCOPE).accessToken());
        assertEquals("access-2", broker.getAccessToken(USER, WORKSPACE, SERVER, SCOPE).accessToken(),
                "a revoked-mid-flight token must not be served from cache");
        verify(service, times(2)).refreshLocked(USER, WORKSPACE, SERVER, SCOPE);
    }
}
