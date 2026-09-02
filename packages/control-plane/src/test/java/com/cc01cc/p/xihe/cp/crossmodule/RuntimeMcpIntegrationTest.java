package com.cc01cc.p.xihe.cp.crossmodule;

import static com.github.tomakehurst.wiremock.client.WireMock.*;
import static org.junit.jupiter.api.Assertions.*;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.http.*;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.beans.factory.annotation.Autowired;
import com.cc01cc.p.xihe.cp.config.JwtTokenProvider;

import java.util.UUID;

class RuntimeMcpIntegrationTest extends AbstractWireMockTest {

    @Autowired
    private JwtTokenProvider jwtTokenProvider;

    @DynamicPropertySource
    static void configureProperties(DynamicPropertyRegistry registry) {
        registry.add("cp.mcp.runtime-url", () -> "http://localhost:" + wireMock.port());
    }

    private static final String TOOLS_LIST_BODY = """
            {"jsonrpc":"2.0","method":"tools/list","id":1}
            """;
    private static final String INITIALIZE_BODY = """
            {"jsonrpc":"2.0","method":"initialize","params":{"protocolVersion":"2026-07-28"},"id":1}
            """;

    private String wsId;
    private String token;

    @BeforeEach
    void setUp() {
        super.setUp();
        token = registerAndLogin();
        wsId = jwtTokenProvider.getWorkspaceIdFromToken(token);
    }

    private HttpEntity<String> mcpEntity(String body) {
        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.APPLICATION_JSON);
        headers.setBearerAuth(token);
        headers.set("X-Workspace-Id", wsId);
        return new HttpEntity<>(body, headers);
    }

    private String initializeMcpSession(String rawSessionId) {
        String runtimePath = "/internal/v1/runtime/workspaces/" + wsId + "/mcp";
        wireMock.stubFor(post(urlEqualTo(runtimePath))
                .withRequestBody(containing("\"method\":\"initialize\""))
                .willReturn(aResponse()
                        .withStatus(200)
                        .withHeader("Content-Type", "application/json")
                        .withHeader("mcp-session-id", rawSessionId)
                        .withBody("{\"jsonrpc\":\"2.0\",\"result\":{\"protocolVersion\":\"2026-07-28\",\"capabilities\":{}},\"id\":1}")));

        ResponseEntity<String> response = restTemplate.postForEntity(
                url("/api/v1/mcp"), mcpEntity(INITIALIZE_BODY), String.class);
        assertEquals(HttpStatus.OK, response.getStatusCode());
        String gatewaySessionId = response.getHeaders().getFirst("mcp-session-id");
        assertNotNull(gatewaySessionId);
        return gatewaySessionId;
    }

    private HttpEntity<String> mcpEntityWithSession(String body, String gatewaySessionId) {
        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.APPLICATION_JSON);
        headers.setBearerAuth(token);
        headers.set("X-Workspace-Id", wsId);
        headers.set("mcp-session-id", gatewaySessionId);
        return new HttpEntity<>(body, headers);
    }

    private HttpEntity<String> serviceMcpEntityWithSession(String body, String gatewaySessionId) {
        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.APPLICATION_JSON);
        headers.setBearerAuth("dev-token-not-secure");
        headers.set("X-Workspace-Id", wsId);
        headers.set("mcp-session-id", gatewaySessionId);
        return new HttpEntity<>(body, headers);
    }

    @Test
    void mcpToolsListForwardsToRuntime() {
        String runtimePath = "/internal/v1/runtime/workspaces/" + wsId + "/mcp";
        String gatewaySessionId = initializeMcpSession("runtime-session-" + UUID.randomUUID());

        wireMock.stubFor(post(urlEqualTo(runtimePath))
                .withRequestBody(containing("\"method\":\"tools/list\""))
                .willReturn(aResponse()
                        .withStatus(200)
                        .withHeader("Content-Type", "application/json")
                        .withBody("{\"jsonrpc\":\"2.0\",\"result\":{\"tools\":[]},\"id\":1}")));

        ResponseEntity<String> response = restTemplate.postForEntity(
                url("/api/v1/mcp"), mcpEntityWithSession(TOOLS_LIST_BODY, gatewaySessionId), String.class);

        assertEquals(HttpStatus.OK, response.getStatusCode());

        wireMock.verify(postRequestedFor(urlEqualTo(runtimePath))
                .withHeader("Content-Type", containing("application/json"))
                .withRequestBody(containing("tools/list")));
    }

    @Test
    void mcpToolsListForwardsSessionIdHeader() {
        String runtimePath = "/internal/v1/runtime/workspaces/" + wsId + "/mcp";
        String rawSessionId = "runtime-session-" + UUID.randomUUID();
        String gatewaySessionId = initializeMcpSession(rawSessionId);

        wireMock.stubFor(post(urlEqualTo(runtimePath))
                .withRequestBody(containing("\"method\":\"tools/list\""))
                .willReturn(aResponse()
                        .withStatus(200)
                        .withHeader("Content-Type", "application/json")
                        .withBody("{\"jsonrpc\":\"2.0\",\"result\":{\"tools\":[]},\"id\":1}")));

        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.APPLICATION_JSON);
        headers.setBearerAuth(token);
        headers.set("X-Workspace-Id", wsId);
        headers.set("mcp-session-id", gatewaySessionId);
        HttpEntity<String> entity = new HttpEntity<>(TOOLS_LIST_BODY, headers);

        ResponseEntity<String> response = restTemplate.postForEntity(
                url("/api/v1/mcp"), entity, String.class);

        assertEquals(HttpStatus.OK, response.getStatusCode());

        wireMock.verify(postRequestedFor(urlEqualTo(runtimePath))
                .withHeader("mcp-session-id", equalTo(rawSessionId)));
    }

    @Test
    void mcpReturns400WhenMissingWorkspaceId() {
        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.APPLICATION_JSON);
        headers.setBearerAuth(jwtTokenProvider.createAccessToken(
                "no-workspace-user", "no-workspace@test.com", "USER", null));
        HttpEntity<String> entity = new HttpEntity<>(TOOLS_LIST_BODY, headers);

        ResponseEntity<String> response = restTemplate.postForEntity(
                url("/api/v1/mcp"), entity, String.class);

        assertEquals(HttpStatus.UNAUTHORIZED, response.getStatusCode());
    }

    @Test
    void mcpToolsListHandlesRuntimeErrorGracefully() {
        String runtimePath = "/internal/v1/runtime/workspaces/" + wsId + "/mcp";
        String gatewaySessionId = initializeMcpSession("runtime-session-" + UUID.randomUUID());
        wireMock.stubFor(post(urlEqualTo(runtimePath))
                .withRequestBody(containing("\"method\":\"tools/list\""))
                .willReturn(aResponse().withStatus(500)));

        ResponseEntity<String> response = restTemplate.postForEntity(
                url("/api/v1/mcp"), mcpEntityWithSession(TOOLS_LIST_BODY, gatewaySessionId), String.class);

        assertEquals(HttpStatus.OK, response.getStatusCode());
        assertTrue(response.getBody().contains("\"tools\""));

        wireMock.verify(postRequestedFor(urlEqualTo(runtimePath))
                .withRequestBody(containing("\"method\":\"tools/list\"")));
    }

    @Test
    void mcpGetForwardsSseHeadersAndBody() {
        String runtimePath = "/internal/v1/runtime/workspaces/" + wsId + "/mcp";
        String rawSessionId = "runtime-session-" + UUID.randomUUID();
        String gatewaySessionId = initializeMcpSession(rawSessionId);
        wireMock.stubFor(get(urlEqualTo(runtimePath))
                .willReturn(aResponse()
                        .withStatus(200)
                        .withHeader("Content-Type", "text/event-stream")
                        .withHeader("Last-Event-ID", "evt-2")
                        .withBody("event: message\ndata: {\"ok\":true}\n\n")));

        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(token);
        headers.set("X-Workspace-Id", wsId);
        headers.set("MCP-Protocol-Version", "2026-07-28");
        headers.set("Last-Event-ID", "evt-1");
        headers.set("mcp-session-id", gatewaySessionId);
        ResponseEntity<String> response = restTemplate.exchange(
                url("/api/v1/mcp"), HttpMethod.GET, new HttpEntity<>(headers), String.class);

        assertEquals(HttpStatus.OK, response.getStatusCode());
        assertEquals("text/event-stream", response.getHeaders().getFirst("Content-Type"));
        assertEquals("evt-2", response.getHeaders().getFirst("Last-Event-ID"));
        assertTrue(response.getBody().contains("event: message"));
        wireMock.verify(getRequestedFor(urlEqualTo(runtimePath))
                .withHeader("Last-Event-ID", equalTo("evt-1"))
                .withHeader("MCP-Protocol-Version", equalTo("2026-07-28"))
                .withHeader("mcp-session-id", equalTo(rawSessionId)));
    }

    @Test
    void mcpDeleteForwardsSessionToRuntime() {
        String runtimePath = "/internal/v1/runtime/workspaces/" + wsId + "/mcp";
        String rawSessionId = "runtime-session-" + UUID.randomUUID();
        String gatewaySessionId = initializeMcpSession(rawSessionId);
        wireMock.stubFor(delete(urlEqualTo(runtimePath))
                .willReturn(aResponse()
                        .withStatus(200)
                        .withHeader("Content-Type", "application/json")
                        .withBody("{\"jsonrpc\":\"2.0\",\"result\":{\"disconnected\":true}}")));

        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(token);
        headers.set("X-Workspace-Id", wsId);
        headers.set("mcp-session-id", gatewaySessionId);
        ResponseEntity<String> response = restTemplate.exchange(
                url("/api/v1/mcp"), HttpMethod.DELETE, new HttpEntity<>(headers), String.class);

        assertEquals(HttpStatus.OK, response.getStatusCode());
        assertTrue(response.getBody().contains("disconnected"));
        wireMock.verify(deleteRequestedFor(urlEqualTo(runtimePath))
                .withHeader("mcp-session-id", equalTo(rawSessionId))
                .withHeader("MCP-Protocol-Version", equalTo("2026-07-28")));
    }

    @Test
    void mcpServicePrincipalAuthorizesWorkspaceWithoutTenantUser() {
        String runtimePath = "/internal/v1/runtime/workspaces/" + wsId + "/mcp";
        wireMock.stubFor(post(urlEqualTo(runtimePath))
                .withRequestBody(containing("\"method\":\"initialize\""))
                .willReturn(aResponse()
                        .withStatus(200)
                        .withHeader("Content-Type", "application/json")
                        .withHeader("mcp-session-id", "service-runtime-session")
                        .withBody("{\"jsonrpc\":\"2.0\",\"result\":{},\"id\":1}")));

        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.APPLICATION_JSON);
        headers.setBearerAuth("dev-token-not-secure");
        headers.set("X-Workspace-Id", wsId);
        ResponseEntity<String> response = restTemplate.postForEntity(
                url("/api/v1/mcp"), new HttpEntity<>(INITIALIZE_BODY, headers), String.class);

        assertEquals(HttpStatus.OK, response.getStatusCode());
        assertNotNull(response.getHeaders().getFirst("mcp-session-id"));
        wireMock.verify(postRequestedFor(urlEqualTo(runtimePath))
                .withHeader("Authorization", equalTo("Bearer dev-token-not-secure")));

        String gatewaySessionId = response.getHeaders().getFirst("mcp-session-id");
        wireMock.stubFor(post(urlEqualTo(runtimePath))
                .withRequestBody(containing("\"method\":\"tools/list\""))
                .willReturn(aResponse()
                        .withStatus(200)
                        .withHeader("Content-Type", "application/json")
                        .withBody("{\"jsonrpc\":\"2.0\",\"result\":{\"tools\":[]},\"id\":1}")));
        ResponseEntity<String> followUp = restTemplate.postForEntity(
                url("/api/v1/mcp"), serviceMcpEntityWithSession(TOOLS_LIST_BODY, gatewaySessionId), String.class);
        assertEquals(HttpStatus.OK, followUp.getStatusCode());
    }

    @Test
    void mcpRejectsWorkspaceHeaderThatDiffersFromAuthenticatedToken() {
        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.APPLICATION_JSON);
        headers.setBearerAuth(token);
        headers.set("X-Workspace-Id", "other-workspace");

        ResponseEntity<String> response = restTemplate.postForEntity(
                url("/api/v1/mcp"), new HttpEntity<>(INITIALIZE_BODY, headers), String.class);

        assertEquals(HttpStatus.FORBIDDEN, response.getStatusCode());
    }

    @Test
    void mcpGetRejectsWorkspaceHeaderWithoutBoundSession() {
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(token);
        headers.set("X-Workspace-Id", wsId);

        ResponseEntity<String> response = restTemplate.exchange(
                url("/api/v1/mcp"), HttpMethod.GET, new HttpEntity<>(headers), String.class);

        assertEquals(HttpStatus.BAD_REQUEST, response.getStatusCode());
    }

    @Test
    void mcpDeleteRejectsWorkspaceHeaderWithoutBoundSession() {
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(token);
        headers.set("X-Workspace-Id", wsId);

        ResponseEntity<String> response = restTemplate.exchange(
                url("/api/v1/mcp"), HttpMethod.DELETE, new HttpEntity<>(headers), String.class);

        assertEquals(HttpStatus.BAD_REQUEST, response.getStatusCode());
    }
}
