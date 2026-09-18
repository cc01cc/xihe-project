package com.cc01cc.p.xihe.cp.oauth;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.CyclicBarrier;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import com.cc01cc.p.xihe.cp.AbstractIntegrationTest;
import com.cc01cc.p.xihe.cp.auth.AuthResponse;
import com.cc01cc.p.xihe.cp.auth.RegisterRequest;
import com.cc01cc.p.xihe.cp.entity.McpServer;
import com.cc01cc.p.xihe.cp.entity.OAuthCredential;
import com.cc01cc.p.xihe.cp.entity.User;
import com.cc01cc.p.xihe.cp.integration.TestDataFactory;
import com.cc01cc.p.xihe.cp.repository.McpServerRepository;
import com.cc01cc.p.xihe.cp.repository.OAuthCredentialRepository;
import com.cc01cc.p.xihe.cp.repository.UserRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceRepository;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.web.client.HttpServerErrorException;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0349 PostgreSQL suite: S4 rotation under forced lock contention (real
 * {@code SELECT ... FOR UPDATE} serialization; H2 cannot express the lock
 * semantics) and the PLAN-0346 lock wait timeout surfacing as 503
 * {@code OPERATION_LOCK_TIMEOUT} at the HTTP edge.
 */
class OAuthBrokerLockTimeoutIntegrationTest extends AbstractIntegrationTest {

    private static final String SCOPE = "mcp:tools";

    @DynamicPropertySource
    static void lockTimeout(DynamicPropertyRegistry registry) {
        registry.add("cp.lock-timeout-ms", () -> "1000");
    }

    @Autowired
    private OAuthCredentialService service;

    @Autowired
    private OAuthCredentialRepository credentialRepository;

    @Autowired
    private McpServerRepository mcpServerRepository;

    @Autowired
    private WorkspaceRepository workspaceRepository;

    @Autowired
    private UserRepository userRepository;

    @Autowired
    private EnvelopeEncryptionService encryption;

    @Autowired
    private PlatformTransactionManager transactionManager;

    private ProviderStub provider;
    private String userId;
    private String workspaceId;
    private String serverId;

    @BeforeEach
    void setUp() throws Exception {
        String email = "oauth-broker-" + UUID.randomUUID().toString().substring(0, 8) + "@test.com";
        ResponseEntity<AuthResponse> registration = restTemplate.postForEntity(
                baseUrl + "/api/v1/auth/register",
                new RegisterRequest(email, TestDataFactory.PASSWORD, "OAuth Broker PG Test"),
                AuthResponse.class);
        assertTrue(registration.getStatusCode().is2xxSuccessful(), "registration must succeed");
        User user = userRepository.findByEmail(email).orElseThrow();
        userId = user.getId().toString();
        workspaceId = workspaceRepository.findActiveByMemberUserId(user.getId())
                .stream().findFirst().orElseThrow().getId().toString();

        provider = new ProviderStub();
        serverId = UUID.randomUUID().toString();
        McpServer server = new McpServer(workspaceId, "pg-broker-server", "https://broker.example/mcp");
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

    private void credential(String refreshToken) {
        OAuthCredential credential = new OAuthCredential();
        credential.setUserId(userId);
        credential.setWorkspaceId(workspaceId);
        credential.setServerId(serverId);
        credential.setClientId("pg-broker-client");
        credential.setTokenEndpoint(provider.tokenEndpoint());
        credential.setRedirectUri("http://127.0.0.1/callback");
        credential.setScope(SCOPE);
        credential.setRefreshTokenCiphertext(encryption.encrypt(refreshToken,
                userId + ":" + workspaceId + ":" + serverId));
        credential.setEncryptionKeyVersion(encryption.currentVersion());
        credential.setStatus("AUTHORIZED");
        credentialRepository.save(credential);
    }

    @Test
    void s4TwoRefreshesUnderContentionSerializeOnTheCredentialRow() throws Exception {
        credential("refresh-1");

        LockHolder holder = holdLock();
        ExecutorService pool = Executors.newFixedThreadPool(2);
        Future<OAuthCredentialService.RefreshResult> first;
        Future<OAuthCredentialService.RefreshResult> second;
        try {
            CyclicBarrier startTogether = new CyclicBarrier(2);
            first = pool.submit(() -> {
                startTogether.await(5, TimeUnit.SECONDS);
                return service.refreshLocked(userId, workspaceId, serverId, SCOPE);
            });
            second = pool.submit(() -> {
                startTogether.await(5, TimeUnit.SECONDS);
                return service.refreshLocked(userId, workspaceId, serverId, SCOPE);
            });
        } finally {
            holder.close();
        }

        OAuthCredentialService.RefreshResult firstResult = first.get(20, TimeUnit.SECONDS);
        OAuthCredentialService.RefreshResult secondResult = second.get(20, TimeUnit.SECONDS);
        pool.shutdownNow();

        assertEquals(2, provider.refreshRequests.get(), "both refreshes must reach the provider");
        assertEquals(0, provider.invalidGrantResponses.get(),
                "the row lock must prevent two refreshes from consuming the same refresh token");
        assertEquals(2, provider.presentedTokens.size(),
                "the second refresh must present the rotated token: " + provider.presentedTokens);
        assertNotEquals(firstResult.accessToken(), secondResult.accessToken());
        assertEquals("refresh-1", provider.presentedTokens.get(0));
        assertEquals(provider.issuedTokens.get(0), provider.presentedTokens.get(1),
                "the second refresh must present what the first one returned (serial rotation chain)");

        OAuthCredential stored = credentialRepository
                .findByUserIdAndWorkspaceIdAndServerId(userId, workspaceId, serverId).orElseThrow();
        String storedRefresh = encryption.decrypt(stored.getRefreshTokenCiphertext(),
                userId + ":" + workspaceId + ":" + serverId);
        assertEquals(provider.issuedTokens.get(1), storedRefresh,
                "ciphertext must hold the last valid rotation");
    }

    @Test
    void lockWaitTimeoutSurfacesAs503OperationLockTimeoutAndRecovers() throws Exception {
        credential("refresh-1");
        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.APPLICATION_JSON);
        headers.setBearerAuth("dev-token-not-secure");
        Map<String, String> body = Map.of(
                "userId", userId, "workspaceId", workspaceId, "serverId", serverId, "scope", SCOPE);

        try (LockHolder ignored = holdLock()) {
            long start = System.nanoTime();
            HttpServerErrorException error = assertThrows(HttpServerErrorException.class, () ->
                    restTemplate.exchange(baseUrl + "/internal/v1/oauth/token", HttpMethod.POST,
                            new HttpEntity<>(body, headers), Map.class));
            long elapsedMs = (System.nanoTime() - start) / 1_000_000;
            assertEquals(HttpStatus.SERVICE_UNAVAILABLE, error.getStatusCode());
            assertTrue(error.getResponseBodyAsString().contains("OPERATION_LOCK_TIMEOUT"),
                    "problem code must be explicit: " + error.getResponseBodyAsString());
            assertTrue(elapsedMs >= 500, "lock timeout must be applied (elapsed=" + elapsedMs + "ms)");
            assertTrue(elapsedMs < 5_000, "wait must be bounded (elapsed=" + elapsedMs + "ms)");
        }

        ResponseEntity<Map> ok = restTemplate.exchange(baseUrl + "/internal/v1/oauth/token", HttpMethod.POST,
                new HttpEntity<>(body, headers), Map.class);
        assertEquals(HttpStatus.OK, ok.getStatusCode(), "retry after lock release must succeed");
        assertEquals(1, provider.refreshRequests.get());
    }

    private LockHolder holdLock() throws InterruptedException {
        return new LockHolder(transactionManager,
                () -> credentialRepository.findForUpdate(userId, workspaceId, serverId)
                        .orElseThrow(() -> new IllegalStateException("credential row missing")));
    }

    private static final class LockHolder implements AutoCloseable {
        private final ExecutorService executor = Executors.newSingleThreadExecutor();
        private final CountDownLatch held = new CountDownLatch(1);
        private final CountDownLatch release = new CountDownLatch(1);
        private final Future<?> future;
        private boolean closed;

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
            if (closed) {
                return;
            }
            closed = true;
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

    /** Rotating provider stub; re-using a consumed refresh token yields invalid_grant. */
    private static final class ProviderStub implements AutoCloseable {
        private final HttpServer server;
        private final ExecutorService pool = Executors.newFixedThreadPool(2);
        private final AtomicInteger refreshRequests = new AtomicInteger();
        private final AtomicInteger invalidGrantResponses = new AtomicInteger();
        private final List<String> presentedTokens = new CopyOnWriteArrayList<>();
        private final List<String> issuedTokens = new CopyOnWriteArrayList<>();
        private volatile String currentRefresh = "refresh-1";

        private ProviderStub() throws IOException {
            server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
            server.setExecutor(pool);
            server.createContext("/token", exchange -> {
                String body = new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8);
                if (!"refresh_token".equals(param(body, "grant_type"))) {
                    respond(exchange, 400, "{\"error\":\"unsupported_grant_type\"}");
                    return;
                }
                int number = refreshRequests.incrementAndGet();
                String presented = param(body, "refresh_token");
                presentedTokens.add(presented);
                if (!presented.equals(currentRefresh)) {
                    invalidGrantResponses.incrementAndGet();
                    respond(exchange, 400, "{\"error\":\"invalid_grant\"}");
                    return;
                }
                String rotated = "rotated-" + UUID.randomUUID();
                currentRefresh = rotated;
                issuedTokens.add(rotated);
                respond(exchange, 200, "{\"access_token\":\"pg-access-" + number
                        + "\",\"refresh_token\":\"" + rotated
                        + "\",\"expires_in\":300,\"scope\":\"mcp:tools\"}");
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

        private static void respond(HttpExchange exchange, int status, String body) throws IOException {
            byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().add("Content-Type", "application/json");
            exchange.sendResponseHeaders(status, bytes.length);
            try (OutputStream out = exchange.getResponseBody()) {
                out.write(bytes);
            }
        }

        private static String param(String body, String name) {
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
