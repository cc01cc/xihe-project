package com.cc01cc.p.xihe.cp.oauth;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CyclicBarrier;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import com.cc01cc.p.xihe.cp.entity.McpServer;
import com.cc01cc.p.xihe.cp.entity.OAuthCredential;
import com.cc01cc.p.xihe.cp.entity.Workspace;
import com.cc01cc.p.xihe.cp.repository.McpServerRepository;
import com.cc01cc.p.xihe.cp.repository.OAuthCredentialRepository;
import com.cc01cc.p.xihe.cp.repository.WorkspaceRepository;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.annotation.DirtiesContext;
import org.springframework.test.context.ActiveProfiles;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * PLAN-0349 single-flight regression for the same credential triple.
 *
 * <p>Originally written for M0 T0.2 as the RMO-1 race probe: against the
 * pre-broker code (A03 {@code b68d58c}) it deterministically reproduced two
 * concurrent refreshes presenting the same pre-rotation refresh token, one of
 * them failing with {@code invalid_grant} (evidence/race-probe.md). Since M1
 * the broker must merge same-key requests into one provider refresh; the
 * 8-way caller barrier keeps the assertion on real concurrency rather than a
 * sequential shortcut.
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles("h2")
@DirtiesContext(classMode = DirtiesContext.ClassMode.AFTER_CLASS)
class OAuthRefreshRaceProbeTest {

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

    private HttpServer provider;
    private ExecutorService providerPool;

    @AfterEach
    void stopProvider() {
        if (provider != null) {
            provider.stop(0);
            provider = null;
        }
        if (providerPool != null) {
            providerPool.shutdownNow();
            providerPool = null;
        }
    }

    @Test
    void concurrentSameKeyRequestsTriggerExactlyOneRefresh() throws Exception {
        String userId = UUID.randomUUID().toString();
        String workspaceId = workspaceRepository.save(new Workspace("race-probe", userId)).getId().toString();
        String serverId = UUID.randomUUID().toString();
        String scope = "mcp:tools";

        provider = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        providerPool = Executors.newFixedThreadPool(8);
        provider.setExecutor(providerPool);

        AtomicInteger refreshRequests = new AtomicInteger();
        Set<String> presentedRefreshTokens = ConcurrentHashMap.newKeySet();
        Object rotationLock = new Object();
        String[] currentRefresh = { "refresh-1" };

        provider.createContext("/token", exchange -> {
            String body = new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8);
            if (!"refresh_token".equals(param(body, "grant_type"))) {
                respond(exchange, 400, "{\"error\":\"unsupported_grant_type\"}");
                return;
            }
            int requestNumber = refreshRequests.incrementAndGet();
            presentedRefreshTokens.add(param(body, "refresh_token"));
            synchronized (rotationLock) {
                if (!param(body, "refresh_token").equals(currentRefresh[0])) {
                    respond(exchange, 400, "{\"error\":\"invalid_grant\"}");
                    return;
                }
                String rotated = "refresh-" + UUID.randomUUID();
                currentRefresh[0] = rotated;
                respond(exchange, 200, "{\"access_token\":\"access-" + requestNumber
                        + "\",\"refresh_token\":\"" + rotated
                        + "\",\"expires_in\":300,\"scope\":\"mcp:tools\"}");
            }
        });
        provider.start();
        String tokenEndpoint = "http://127.0.0.1:" + provider.getAddress().getPort() + "/token";

        McpServer server = new McpServer(workspaceId, "probe-server", "https://probe.example/mcp");
        server.setId(UUID.fromString(serverId));
        server.setEnabled(true);
        mcpServerRepository.save(server);

        OAuthCredential credential = new OAuthCredential();
        credential.setUserId(userId);
        credential.setWorkspaceId(workspaceId);
        credential.setServerId(serverId);
        credential.setClientId("probe-client");
        credential.setTokenEndpoint(tokenEndpoint);
        credential.setRedirectUri("http://127.0.0.1/callback");
        credential.setScope(scope);
        credential.setRefreshTokenCiphertext(encryption.encrypt("refresh-1", userId + ":" + workspaceId + ":" + serverId));
        credential.setEncryptionKeyVersion(encryption.currentVersion());
        credential.setStatus("AUTHORIZED");
        credentialRepository.save(credential);

        int callers = 8;
        ExecutorService callersPool = Executors.newFixedThreadPool(callers);
        CyclicBarrier startTogether = new CyclicBarrier(callers);
        List<String> outcomes = Collections.synchronizedList(new ArrayList<>());
        List<Future<?>> futures = new ArrayList<>();
        for (int i = 0; i < callers; i++) {
            futures.add(callersPool.submit(() -> {
                try {
                    startTogether.await(5, TimeUnit.SECONDS);
                    OAuthCredentialService.AccessGrant grant =
                            service.issueAccessToken(userId, workspaceId, serverId, scope);
                    outcomes.add("OK " + grant.accessToken());
                } catch (Exception e) {
                    outcomes.add("FAIL " + e.getClass().getSimpleName() + " " + e.getMessage());
                }
            }));
        }
        for (Future<?> future : futures) {
            future.get(30, TimeUnit.SECONDS);
        }
        callersPool.shutdownNow();

        System.out.println("[S1] provider refresh requests=" + refreshRequests.get()
                + " presented=" + presentedRefreshTokens + " outcomes=" + outcomes);

        assertEquals(callers, outcomes.size());
        assertTrue(outcomes.stream().allMatch(outcome -> outcome.startsWith("OK")),
                "all concurrent callers must succeed: " + outcomes);
        assertEquals(1, refreshRequests.get(),
                "single-flight must merge same-key refreshes into one provider call");
        assertEquals(1, outcomes.stream().distinct().count(),
                "all callers must receive the same access token: " + outcomes);
    }

    private static String param(String body, String name) {
        for (String pair : body.split("&")) {
            String[] parts = pair.split("=", 2);
            if (parts.length == 2 && name.equals(java.net.URLDecoder.decode(parts[0], StandardCharsets.UTF_8))) {
                return java.net.URLDecoder.decode(parts[1], StandardCharsets.UTF_8);
            }
        }
        return null;
    }

    private static void respond(HttpExchange exchange, int status, String body) throws IOException {
        byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
        exchange.getResponseHeaders().add("Content-Type", "application/json");
        exchange.sendResponseHeaders(status, bytes.length);
        try (OutputStream out = exchange.getResponseBody()) {
            out.write(bytes);
        }
    }
}
