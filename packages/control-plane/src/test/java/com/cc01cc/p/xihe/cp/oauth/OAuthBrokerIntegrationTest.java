package com.cc01cc.p.xihe.cp.oauth;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.Consumer;

import com.cc01cc.p.xihe.cp.entity.McpServer;
import com.cc01cc.p.xihe.cp.entity.OAuthCredential;
import com.cc01cc.p.xihe.cp.repository.McpServerRepository;
import com.cc01cc.p.xihe.cp.repository.OAuthCredentialRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceRepository;
import com.cc01cc.p.xihe.cp.entity.Workspace;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.core.read.ListAppender;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.test.annotation.DirtiesContext;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0349 broker integration scenarios S2/S5/S6/S7 on H2 (no row-lock
 * timing semantics here — those live in the PostgreSQL suite), plus the HTTP
 * error mapping of the internal broker endpoint and log redaction (S8).
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles("h2")
@DirtiesContext(classMode = DirtiesContext.ClassMode.AFTER_CLASS)
class OAuthBrokerIntegrationTest {

    private static final String SCOPE = "mcp:tools";

    @LocalServerPort
    private int port;

    @Autowired
    private OAuthCredentialService service;

    @Autowired
    private OAuthCredentialRepository credentialRepository;

    @Autowired
    private WorkspaceRepository workspaceRepository;

    @Autowired
    private McpServerRepository mcpServerRepository;

    @Autowired
    private EnvelopeEncryptionService encryption;

    @Autowired
    private PlatformTransactionManager transactionManager;

    @Autowired
    private ObjectMapper objectMapper;

    private ProviderStub provider;
    private String userId;
    private String workspaceId;
    private String serverId;

    @BeforeEach
    void setUp() throws Exception {
        provider = new ProviderStub();
        userId = UUID.randomUUID().toString();
        workspaceId = workspaceRepository.save(new Workspace("broker-it", userId)).getId().toString();
        serverId = UUID.randomUUID().toString();
        McpServer server = new McpServer(workspaceId, "broker-server", "https://broker.example/mcp");
        server.setId(UUID.fromString(serverId));
        server.setEnabled(true);
        mcpServerRepository.save(server);
    }

    @AfterEach
    void tearDown() {
        if (provider != null) {
            provider.close();
            provider = null;
        }
    }

    private void credential(String refreshToken, String scope, String status, String tokenEndpoint) {
        OAuthCredential credential = new OAuthCredential();
        credential.setUserId(userId);
        credential.setWorkspaceId(workspaceId);
        credential.setServerId(serverId);
        credential.setClientId("broker-client");
        credential.setTokenEndpoint(tokenEndpoint);
        credential.setRedirectUri("http://127.0.0.1/callback");
        credential.setScope(scope);
        credential.setRefreshTokenCiphertext(encryption.encrypt(refreshToken,
                userId + ":" + workspaceId + ":" + serverId));
        credential.setEncryptionKeyVersion(encryption.currentVersion());
        credential.setStatus(status);
        credentialRepository.save(credential);
    }

    private void credential() {
        credential("refresh-1", SCOPE, "AUTHORIZED", provider.tokenEndpoint());
    }

    private OAuthCredentialService.AccessGrant token() {
        return service.issueAccessToken(userId, workspaceId, serverId, SCOPE);
    }

    private RawResponse postTokenHttp(Map<String, String> body) throws Exception {
        java.net.http.HttpRequest request = java.net.http.HttpRequest.newBuilder(
                        java.net.URI.create("http://localhost:" + port + "/internal/v1/oauth/token"))
                .header("Authorization", "Bearer dev-token-not-secure")
                .header("Content-Type", "application/json")
                .POST(java.net.http.HttpRequest.BodyPublishers.ofString(objectMapper.writeValueAsString(body)))
                .build();
        java.net.http.HttpResponse<String> response =
                java.net.http.HttpClient.newHttpClient().send(request, java.net.http.HttpResponse.BodyHandlers.ofString());
        return new RawResponse(response.statusCode(), response.body());
    }

    /** RestTemplate discards problem bodies on 401, so the raw client is used. */
    private record RawResponse(int status, String body) {}

    // ---------------------------------------------------------------- scenarios

    @Test
    void s2SecondCallIsServedFromCacheWithoutProviderRoundTrip() {
        credential();
        assertEquals("access-1", token().accessToken());
        assertEquals("access-1", token().accessToken());
        assertEquals(1, provider.refreshRequests.get());
    }

    @Test
    void s5RevokeInvalidatesCacheAndNextCallRequiresReauth() {
        credential();
        assertEquals("access-1", token().accessToken());

        assertTrue(service.revoke(userId, workspaceId, serverId));

        OAuthBrokerException failure = assertThrows(OAuthBrokerException.class, this::token);
        assertEquals(OAuthBrokerException.Kind.REAUTH_REQUIRED, failure.kind());
        assertThrows(OAuthBrokerException.class, this::token);
        assertEquals(1, provider.refreshRequests.get(), "revoked credential must never call the provider again");
    }

    @Test
    void s5RefreshInFlightThenRevokeLeavesTheCredentialRevoked() throws Exception {
        credential();
        provider.blockFirstRefresh = true;

        ExecutorService pool = Executors.newFixedThreadPool(2);
        try {
            Future<OAuthCredentialService.AccessGrant> refresh = pool.submit(this::token);
            assertTrue(provider.firstRefreshStarted.await(5, TimeUnit.SECONDS));

            Future<Boolean> revoke = pool.submit(() -> service.revoke(userId, workspaceId, serverId));
            provider.releaseFirstRefresh.countDown();

            assertEquals("access-1", refresh.get(10, TimeUnit.SECONDS).accessToken());
            assertTrue(revoke.get(10, TimeUnit.SECONDS));
        } finally {
            pool.shutdownNow();
        }

        assertEquals(1, provider.refreshRequests.get());
        OAuthBrokerException failure = assertThrows(OAuthBrokerException.class, this::token);
        assertEquals(OAuthBrokerException.Kind.REAUTH_REQUIRED, failure.kind());
        assertEquals(1, provider.refreshRequests.get(), "cache must not be resurrected after revoke");
    }

    @Test
    void s5RevokeCommittedWhileRefreshWaitsOnTheLockIsNotResurrected() throws Exception {
        credential();
        LockHolder holder = holdLock(credential -> {
            credential.setStatus("REVOKED");
            credential.setRefreshTokenCiphertext("revoked");
        });
        ExecutorService pool = Executors.newSingleThreadExecutor();
        try {
            Future<OAuthBrokerException> refresh = pool.submit(() -> assertThrows(
                    OAuthBrokerException.class, this::token));
            // The refresh thread must be blocked on the row lock while the revoke commits.
            assertThrows(java.util.concurrent.TimeoutException.class,
                    () -> refresh.get(250, TimeUnit.MILLISECONDS));
            holder.close();
            OAuthBrokerException failure = refresh.get(15, TimeUnit.SECONDS);
            assertEquals(OAuthBrokerException.Kind.REAUTH_REQUIRED, failure.kind());
        } finally {
            holder.close();
            pool.shutdownNow();
        }
        assertEquals(0, provider.refreshRequests.get(), "refresh must re-read REVOKED under the lock");
    }

    @Test
    void s7MissingCredentialAndScopeMismatchAreReauthWithoutProviderCalls() {
        OAuthBrokerException missing = assertThrows(OAuthBrokerException.class,
                () -> service.issueAccessToken(userId, workspaceId, serverId, SCOPE));
        assertEquals(OAuthBrokerException.Kind.REAUTH_REQUIRED, missing.kind());

        credential();
        OAuthBrokerException mismatch = assertThrows(OAuthBrokerException.class,
                () -> service.issueAccessToken(userId, workspaceId, serverId, "other:scope"));
        assertEquals(OAuthBrokerException.Kind.REAUTH_REQUIRED, mismatch.kind());
        assertEquals(0, provider.refreshRequests.get());

        OAuthCredential row = credentialRepository
                .findByUserIdAndWorkspaceIdAndServerId(userId, workspaceId, serverId).orElseThrow();
        row.setStatus("REVOKED");
        credentialRepository.save(row);
        OAuthBrokerException revoked = assertThrows(OAuthBrokerException.class, this::token);
        assertEquals(OAuthBrokerException.Kind.REAUTH_REQUIRED, revoked.kind());
        assertEquals(0, provider.refreshRequests.get());
    }

    @Test
    void s6ProviderServerErrorAndConnectionFailureAreUnavailable() {
        provider.refreshFailureStatus = 500;
        provider.failureBody = "{\"error\":\"server_error\"}";
        credential();
        OAuthBrokerException serverError = assertThrows(OAuthBrokerException.class, this::token);
        assertEquals(OAuthBrokerException.Kind.TOKEN_UNAVAILABLE, serverError.kind());
        assertTrue(serverError.getMessage().contains("500"), "status must be classified without the body: "
                + serverError.getMessage());
        assertFalse(serverError.getMessage().contains("server_error"),
                "provider error body must not leak into the broker message");

        OAuthCredential row = credentialRepository.findByUserIdAndWorkspaceIdAndServerId(userId, workspaceId, serverId)
                .orElseThrow();
        row.setTokenEndpoint("http://127.0.0.1:" + closedPort() + "/token");
        credentialRepository.save(row);
        OAuthBrokerException unreachable = assertThrows(OAuthBrokerException.class,
                () -> service.issueAccessToken(userId, workspaceId, serverId, SCOPE));
        assertEquals(OAuthBrokerException.Kind.TOKEN_UNAVAILABLE, unreachable.kind());
    }

    @Test
    void s7ProviderInvalidGrantIsReauth() {
        provider.refreshFailureStatus = 400;
        provider.failureBody = "{\"error\":\"invalid_grant\"}";
        credential();
        OAuthBrokerException failure = assertThrows(OAuthBrokerException.class, this::token);
        assertEquals(OAuthBrokerException.Kind.REAUTH_REQUIRED, failure.kind());
    }

    // ------------------------------------------------------------- HTTP mapping

    @Test
    void httpMissingCredentialMapsTo401ReauthRequired() throws Exception {
        RawResponse response = postTokenHttp(Map.of(
                "userId", userId, "workspaceId", workspaceId, "serverId", serverId, "scope", SCOPE));
        assertEquals(401, response.status());
        assertTrue(response.body().contains("OAUTH_REAUTH_REQUIRED"),
                "problem code must be explicit: " + response.body());
    }

    @Test
    void httpProviderFailureMapsTo503Unavailable() throws Exception {
        provider.refreshFailureStatus = 500;
        credential();
        RawResponse response = postTokenHttp(Map.of(
                "userId", userId, "workspaceId", workspaceId, "serverId", serverId, "scope", SCOPE));
        assertEquals(503, response.status());
        assertTrue(response.body().contains("OAUTH_TOKEN_UNAVAILABLE"),
                "problem code must be explicit: " + response.body());
    }

    @Test
    void httpInvalidRequestMapsTo400AndAnonymousCallIsRejected() throws Exception {
        RawResponse invalid = postTokenHttp(Map.of(
                "userId", userId, "workspaceId", workspaceId, "serverId", "", "scope", SCOPE));
        assertEquals(400, invalid.status());
        assertTrue(invalid.body().contains("INVALID_REQUEST"),
                "problem code must be explicit: " + invalid.body());

        // Spring Security guards /internal/v1/** before the controller's 403 branch.
        java.net.http.HttpRequest anonymous = java.net.http.HttpRequest.newBuilder(
                        java.net.URI.create("http://localhost:" + port + "/internal/v1/oauth/token"))
                .header("Content-Type", "application/json")
                .POST(java.net.http.HttpRequest.BodyPublishers.ofString(
                        objectMapper.writeValueAsString(Map.of("userId", userId))))
                .build();
        java.net.http.HttpResponse<String> response =
                java.net.http.HttpClient.newHttpClient().send(anonymous, java.net.http.HttpResponse.BodyHandlers.ofString());
        assertEquals(401, response.statusCode());
    }

    // ------------------------------------------------------------- S8 / RFC 7009

    @Test
    void s8LogsNeverContainTokenMaterial() {
        credential();
        ListAppender<ILoggingEvent> appender = attachAppender(OAuthTokenBroker.class, OAuthCredentialService.class,
                OAuthRevocationClient.class);
        String rotatedRefresh;
        try {
            token();
            token();
            OAuthCredential stored = credentialRepository
                    .findByUserIdAndWorkspaceIdAndServerId(userId, workspaceId, serverId).orElseThrow();
            rotatedRefresh = encryption.decrypt(stored.getRefreshTokenCiphertext(),
                    userId + ":" + workspaceId + ":" + serverId);

            String failingServerId = UUID.randomUUID().toString();
            McpServer failingServer = new McpServer(workspaceId, "failing-server", "https://broker.example/mcp");
            failingServer.setId(UUID.fromString(failingServerId));
            failingServer.setEnabled(true);
            mcpServerRepository.save(failingServer);
            OAuthCredential failing = new OAuthCredential();
            failing.setUserId(userId);
            failing.setWorkspaceId(workspaceId);
            failing.setServerId(failingServerId);
            failing.setClientId("broker-client");
            failing.setTokenEndpoint(provider.tokenEndpoint());
            failing.setRedirectUri("http://127.0.0.1/callback");
            failing.setScope(SCOPE);
            failing.setRefreshTokenCiphertext(encryption.encrypt("refresh-failing",
                    userId + ":" + workspaceId + ":" + failingServerId));
            failing.setEncryptionKeyVersion(encryption.currentVersion());
            failing.setStatus("AUTHORIZED");
            credentialRepository.save(failing);

            provider.refreshFailureStatus = 400;
            provider.failureBody = "{\"error\":\"invalid_grant\"}";
            assertThrows(OAuthBrokerException.class,
                    () -> service.issueAccessToken(userId, workspaceId, failingServerId, SCOPE));
            service.revoke(userId, workspaceId, serverId);
        } finally {
            detachAppender(appender);
        }

        String logs = appender.list.stream()
                .map(ILoggingEvent::getFormattedMessage)
                .reduce("", (a, b) -> a + "\n" + b);
        assertTrue(logs.contains("oauth_token_hit"), "hit event must be observable");
        assertTrue(logs.contains("oauth_token_refresh"), "refresh event must be observable");
        assertTrue(logs.contains("oauth_token_failure"), "failure event must be observable");
        assertTrue(logs.contains("oauth_token_revoke"), "revoke event must be observable");
        assertFalse(logs.contains("access-1"), "access token must never be logged");
        assertFalse(logs.contains("refresh-1"), "initial refresh token must never be logged");
        assertFalse(logs.contains("refresh-failing"), "provider refresh token must never be logged");
        assertFalse(logs.contains(rotatedRefresh), "rotated refresh token must never be logged");
    }

    @Test
    void revokeNotifiesTheProviderThroughRfc7009Discovery() {
        credential();
        assertTrue(service.revoke(userId, workspaceId, serverId));
        assertEquals(1, provider.revokeRequests.get(), "best-effort RFC 7009 call must be attempted");
        assertEquals("refresh-1", provider.revokedTokens.get(0));
    }

    @Test
    void revokeWithoutProviderMetadataStaysLocal() {
        provider.serveMetadata = false;
        credential();
        assertTrue(service.revoke(userId, workspaceId, serverId));
        assertEquals(0, provider.revokeRequests.get(), "no revocation endpoint means local-only revoke");
        assertEquals(1, provider.metadataRequests.get(), "discovery must have been attempted");
        assertThrows(OAuthBrokerException.class, this::token);
    }

    // ------------------------------------------------------------------ helpers

    private static int closedPort() {
        try (ServerSocket socket = new ServerSocket(0)) {
            return socket.getLocalPort();
        } catch (IOException e) {
            throw new IllegalStateException("unable to allocate a closed port", e);
        }
    }

    private static ListAppender<ILoggingEvent> attachAppender(Class<?>... loggers) {
        ListAppender<ILoggingEvent> appender = new ListAppender<>();
        appender.start();
        for (Class<?> loggerClass : loggers) {
            ((ch.qos.logback.classic.Logger) org.slf4j.LoggerFactory.getLogger(loggerClass))
                    .addAppender(appender);
        }
        return appender;
    }

    private static void detachAppender(ListAppender<ILoggingEvent> appender) {
        for (Class<?> loggerClass : List.of(OAuthTokenBroker.class, OAuthCredentialService.class,
                OAuthRevocationClient.class)) {
            ((ch.qos.logback.classic.Logger) org.slf4j.LoggerFactory.getLogger(loggerClass))
                    .detachAppender(appender);
        }
    }

    private LockHolder holdLock(Consumer<OAuthCredential> mutation) throws InterruptedException {
        return new LockHolder(transactionManager, () -> credentialRepository
                .findForUpdate(userId, workspaceId, serverId)
                .ifPresent(credential -> {
                    mutation.accept(credential);
                    credentialRepository.save(credential);
                }));
    }

    private static final class LockHolder implements AutoCloseable {
        private final ExecutorService executor = Executors.newSingleThreadExecutor();
        private final CountDownLatch held = new CountDownLatch(1);
        private final CountDownLatch release = new CountDownLatch(1);
        private final Future<?> future;

        private LockHolder(PlatformTransactionManager transactionManager, Runnable acquire)
                throws InterruptedException {
            this.future = executor.submit(() -> new TransactionTemplate(transactionManager).execute(status -> {
                acquire.run();
                held.countDown();
                try {
                    release.await(30, TimeUnit.SECONDS);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                }
                return null;
            }));
            if (!held.await(10, TimeUnit.SECONDS)) {
                throw new IllegalStateException("lock holder did not acquire the row lock in time");
            }
        }

        @Override
        public void close() {
            release.countDown();
            try {
                future.get(30, TimeUnit.SECONDS);
            } catch (Exception e) {
                throw new IllegalStateException("lock holder failed to release", e);
            } finally {
                executor.shutdown();
            }
        }
    }

    /**
     * In-process OAuth provider stub: rotating refresh tokens, configurable
     * failure status, blocking first refresh, RFC 8414/OpenID metadata and a
     * RFC 7009 revocation endpoint.
     */
    private final class ProviderStub implements AutoCloseable {
        private final HttpServer server;
        private final ExecutorService pool = Executors.newFixedThreadPool(4);
        private final AtomicInteger tokenRequests = new AtomicInteger();
        private final AtomicInteger refreshRequests = new AtomicInteger();
        private final AtomicInteger metadataRequests = new AtomicInteger();
        private final AtomicInteger revokeRequests = new AtomicInteger();
        private final List<String> revokedTokens = new ArrayList<>();
        private final Set<String> presentedRefreshTokens = ConcurrentHashMap.newKeySet();
        private final CountDownLatch firstRefreshStarted = new CountDownLatch(1);
        private final CountDownLatch releaseFirstRefresh = new CountDownLatch(1);
        private volatile boolean blockFirstRefresh;
        private volatile int refreshFailureStatus;
        private volatile String failureBody = "{\"error\":\"invalid_grant\"}";
        private volatile boolean serveMetadata = true;
        private String currentRefresh = "refresh-1";
        private final Object rotationLock = new Object();

        private ProviderStub() throws IOException {
            server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
            server.setExecutor(pool);
            server.createContext("/token", exchange -> {
                String body = new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8);
                tokenRequests.incrementAndGet();
                if (!"refresh_token".equals(param(body, "grant_type"))) {
                    respond(exchange, 400, "{\"error\":\"unsupported_grant_type\"}");
                    return;
                }
                int number = refreshRequests.incrementAndGet();
                presentedRefreshTokens.add(param(body, "refresh_token"));
                if (blockFirstRefresh && number == 1) {
                    firstRefreshStarted.countDown();
                    try {
                        releaseFirstRefresh.await(5, TimeUnit.SECONDS);
                    } catch (InterruptedException e) {
                        Thread.currentThread().interrupt();
                    }
                }
                if (refreshFailureStatus != 0) {
                    respond(exchange, refreshFailureStatus, failureBody);
                    return;
                }
                synchronized (rotationLock) {
                    if (!param(body, "refresh_token").equals(currentRefresh)) {
                        respond(exchange, 400, "{\"error\":\"invalid_grant\"}");
                        return;
                    }
                    String rotated = "refresh-" + UUID.randomUUID();
                    currentRefresh = rotated;
                    respond(exchange, 200, "{\"access_token\":\"access-" + number
                            + "\",\"refresh_token\":\"" + rotated
                            + "\",\"expires_in\":300,\"scope\":\"mcp:tools\"}");
                }
            });
            server.createContext("/revoke", exchange -> {
                String body = new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8);
                revokeRequests.incrementAndGet();
                synchronized (revokedTokens) {
                    revokedTokens.add(param(body, "token"));
                }
                exchange.sendResponseHeaders(200, -1);
                exchange.close();
            });
            server.createContext("/.well-known/openid-configuration", exchange -> {
                metadataRequests.incrementAndGet();
                if (!serveMetadata) {
                    respond(exchange, 404, "{\"error\":\"not_found\"}");
                    return;
                }
                respond(exchange, 200, "{\"token_endpoint\":\"" + tokenEndpoint()
                        + "\",\"revocation_endpoint\":\"http://127.0.0.1:" + server.getAddress().getPort()
                        + "/revoke\"}");
            });
            server.start();
        }

        private String tokenEndpoint() {
            return "http://127.0.0.1:" + server.getAddress().getPort() + "/token";
        }

        @Override
        public void close() {
            server.stop(0);
            pool.shutdownNow();
        }

        private void respond(HttpExchange exchange, int status, String body) throws IOException {
            byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().add("Content-Type", "application/json");
            exchange.sendResponseHeaders(status, bytes.length);
            try (OutputStream out = exchange.getResponseBody()) {
                out.write(bytes);
            }
        }

        private String param(String body, String name) {
            for (String pair : body.split("&")) {
                String[] parts = pair.split("=", 2);
                if (parts.length == 2
                        && name.equals(java.net.URLDecoder.decode(parts[0], StandardCharsets.UTF_8))) {
                    return java.net.URLDecoder.decode(parts[1], StandardCharsets.UTF_8);
                }
            }
            return null;
        }
    }
}
