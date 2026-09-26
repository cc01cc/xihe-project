package com.cc01cc.p.xihe.cp.controller;

import com.cc01cc.p.xihe.cp.AbstractH2Test;
import com.cc01cc.p.xihe.cp.entity.Workspace;
import com.cc01cc.p.xihe.cp.repository.WorkspaceRepository;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.http.client.JdkClientHttpRequestFactory;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.web.client.DefaultResponseErrorHandler;
import org.springframework.web.client.RestTemplate;

import java.io.IOException;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;

/**
 * V11 / design #13 (PLAN-0407 G2 Q4): an Agent-side caller only holds the internal service
 * bearer ({@code cp.agent-api-token} = {@code dev-token-not-secure}). The public
 * {@code PATCH /api/v1/workspaces/{id}/execution-mode} route is guarded by
 * {@code hasAnyRole('USER', 'ADMIN')}, so that credential must be rejected with 403 and the
 * workspace row's {@code executionMode} must stay untouched — the bare-execution choice is a
 * human decision, not an Agent capability.
 *
 * <p>The positive control proves the rejection is caused by the credential, not by a broken
 * route: the workspace owner's own JWT performs a real switch (the direct-attach capability probe
 * is stubbed with a local Runtime endpoint), and afterwards the same service bearer still cannot
 * flip the bare carrier back off.</p>
 */
class ExecutionModeAuthorityTest extends AbstractH2Test {

    private static final String INTERNAL_SERVICE_TOKEN = "dev-token-not-secure";

    private static com.sun.net.httpserver.HttpServer probeServer;

    static {
        try {
            probeServer = com.sun.net.httpserver.HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
            probeServer.createContext("/internal/v1/runtime/capabilities/direct-attach/probe", exchange -> {
                byte[] body = ("{\"contractVersion\":\"v1\",\"backendKind\":\"windows-host\","
                        + "\"backendRevision\":\"builtin\",\"maturity\":\"stable\","
                        + "\"executionMode\":\"windows-host\",\"available\":true}")
                        .getBytes(StandardCharsets.UTF_8);
                exchange.getResponseHeaders().set("Content-Type", "application/json");
                exchange.sendResponseHeaders(200, body.length);
                exchange.getResponseBody().write(body);
                exchange.close();
            });
            probeServer.start();
        } catch (IOException e) {
            throw new ExceptionInInitializerError(e);
        }
    }

    @DynamicPropertySource
    static void runtimeProbeUrl(DynamicPropertyRegistry registry) {
        registry.add("cp.mcp.runtime-url", () -> "http://127.0.0.1:" + probeServer.getAddress().getPort());
    }

    @AfterAll
    static void stopProbeServer() {
        if (probeServer != null) {
            probeServer.stop(0);
        }
    }

    @Autowired
    private WorkspaceRepository workspaceRepository;

    private String workspaceId;
    private String userToken;
    private RestTemplate patchClient;

    @BeforeEach
    void registerWorkspaceOwner() {
        // The shared test RestTemplate cannot emit PATCH; the JDK client can, and 4xx must come
        // back as a response entity so the rejection itself is assertable.
        patchClient = new RestTemplate(new JdkClientHttpRequestFactory());
        patchClient.setErrorHandler(new DefaultResponseErrorHandler() {
            @Override
            public boolean hasError(org.springframework.http.HttpStatusCode statusCode) {
                return statusCode.is5xxServerError();
            }
        });
        ResponseEntity<Map> registration = restTemplate.postForEntity(
                url("/api/v1/auth/register"),
                Map.of("email", "execution-mode-" + UUID.randomUUID() + "@test.com",
                        "password", "execution-mode-password", "name", "ExecutionModeTest"),
                Map.class);
        assertEquals(HttpStatus.CREATED, registration.getStatusCode());
        assertNotNull(registration.getBody());
        userToken = (String) registration.getBody().get("accessToken");
        workspaceId = (String) registration.getBody().get("workspaceId");
        assertNotNull(workspaceId, "registration provisions the owner's workspace");
    }

    @Test
    void internalServiceBearerIsRejectedAndExecutionModeStaysUnchanged() {
        assertEquals("docker", workspaceRow().getExecutionMode(),
                "fixture sanity: a fresh workspace starts on the docker execution mode");

        ResponseEntity<Map> rejected = exchangeExecutionMode(INTERNAL_SERVICE_TOKEN, "windows-host");

        assertEquals(HttpStatus.FORBIDDEN, rejected.getStatusCode(),
                "the service bearer carries only ROLE_INTERNAL_SERVICE, never USER/ADMIN");
        assertNotNull(rejected.getBody());
        assertEquals("FORBIDDEN", rejected.getBody().get("code"));
        assertEquals("docker", workspaceRow().getExecutionMode(),
                "a rejected Agent-side PATCH must leave executionMode exactly as it was");
    }

    @Test
    void ownerSwitchesToBareHostAndServiceBearerCannotChangeItBack() {
        Workspace workspace = workspaceRow();
        workspace.setStorageMode("direct_attach");
        workspace.setHostPath("C:\\work\\execution-mode-test");
        workspaceRepository.save(workspace);

        ResponseEntity<Map> accepted = exchangeExecutionMode(userToken, "windows-host");

        assertEquals(HttpStatus.OK, accepted.getStatusCode());
        assertNotNull(accepted.getBody());
        assertEquals("windows-host", accepted.getBody().get("executionMode"));
        assertEquals("windows-host", workspaceRow().getExecutionMode(),
                "the human owner activates the bare carrier through their own credential");

        ResponseEntity<Map> rejected = exchangeExecutionMode(INTERNAL_SERVICE_TOKEN, "docker");

        assertEquals(HttpStatus.FORBIDDEN, rejected.getStatusCode(),
                "the Agent-side caller is stopped at the route guard, before any mode logic");
        assertEquals("windows-host", workspaceRow().getExecutionMode(),
                "the Agent-side caller cannot flip the bare carrier back off");
    }

    private ResponseEntity<Map> exchangeExecutionMode(String bearerToken, String executionMode) {
        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.APPLICATION_JSON);
        headers.setBearerAuth(bearerToken);
        return patchClient.exchange(
                url("/api/v1/workspaces/" + workspaceId + "/execution-mode"),
                HttpMethod.PATCH,
                new HttpEntity<>(Map.of("executionMode", executionMode), headers),
                Map.class);
    }

    private Workspace workspaceRow() {
        return workspaceRepository.findByIdAndDeletedAtIsNull(UUID.fromString(workspaceId)).orElseThrow();
    }
}
