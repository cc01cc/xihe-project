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

    private String wsId;
    private String token;

    @BeforeEach
    void setUp() {
        super.setUp();
        token = registerAndLogin();
        wsId = "mcp-ws-" + UUID.randomUUID().toString().substring(0, 8);
    }

    private HttpEntity<String> mcpEntity(String body) {
        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.APPLICATION_JSON);
        headers.setBearerAuth(token);
        headers.set("X-Workspace-Id", wsId);
        return new HttpEntity<>(body, headers);
    }

    @Test
    void mcpToolsListForwardsToRuntime() {
        String runtimePath = "/internal/v1/runtime/workspaces/" + wsId + "/mcp";

        wireMock.stubFor(post(urlPathMatching("/internal/v1/runtime/workspaces/.*/mcp"))
                .willReturn(aResponse()
                        .withStatus(200)
                        .withHeader("Content-Type", "application/json")
                        .withBody("{\"jsonrpc\":\"2.0\",\"result\":{\"tools\":[]},\"id\":1}")));

        ResponseEntity<String> response = restTemplate.postForEntity(
                url("/api/v1/mcp"), mcpEntity(TOOLS_LIST_BODY), String.class);

        assertEquals(HttpStatus.OK, response.getStatusCode());

        wireMock.verify(postRequestedFor(urlEqualTo(runtimePath))
                .withHeader("Content-Type", containing("application/json"))
                .withRequestBody(containing("tools/list")));
    }

    @Test
    void mcpToolsListForwardsSessionIdHeader() {
        String runtimePath = "/internal/v1/runtime/workspaces/" + wsId + "/mcp";

        wireMock.stubFor(post(urlEqualTo(runtimePath))
                .willReturn(aResponse()
                        .withStatus(200)
                        .withHeader("Content-Type", "application/json")
                        .withBody("{\"jsonrpc\":\"2.0\",\"result\":{\"tools\":[]},\"id\":1}")));

        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.APPLICATION_JSON);
        headers.setBearerAuth(token);
        headers.set("X-Workspace-Id", wsId);
        headers.set("mcp-session-id", "test-session-value");
        HttpEntity<String> entity = new HttpEntity<>(TOOLS_LIST_BODY, headers);

        ResponseEntity<String> response = restTemplate.postForEntity(
                url("/api/v1/mcp"), entity, String.class);

        assertEquals(HttpStatus.OK, response.getStatusCode());

        wireMock.verify(postRequestedFor(urlEqualTo(runtimePath))
                .withHeader("mcp-session-id", containing("test-session-value")));
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

        assertEquals(HttpStatus.BAD_REQUEST, response.getStatusCode());
    }

    @Test
    void mcpToolsListHandlesRuntimeErrorGracefully() {
        wireMock.stubFor(post(urlPathMatching("/internal/v1/runtime/workspaces/.*/mcp"))
                .willReturn(aResponse().withStatus(500)));

        ResponseEntity<String> response = restTemplate.postForEntity(
                url("/api/v1/mcp"), mcpEntity(TOOLS_LIST_BODY), String.class);

        assertEquals(HttpStatus.OK, response.getStatusCode());
        assertTrue(response.getBody().contains("\"tools\""));

        wireMock.verify(postRequestedFor(urlPathMatching("/internal/v1/runtime/workspaces/.*/mcp")));
    }

    @Test
    void mcpGetForwardsSseHeadersAndBody() {
        String runtimePath = "/internal/v1/runtime/workspaces/" + wsId + "/mcp";
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
        ResponseEntity<String> response = restTemplate.exchange(
                url("/api/v1/mcp"), HttpMethod.GET, new HttpEntity<>(headers), String.class);

        assertEquals(HttpStatus.OK, response.getStatusCode());
        assertEquals("text/event-stream", response.getHeaders().getFirst("Content-Type"));
        assertEquals("evt-2", response.getHeaders().getFirst("Last-Event-ID"));
        assertTrue(response.getBody().contains("event: message"));
        wireMock.verify(getRequestedFor(urlEqualTo(runtimePath))
                .withHeader("Last-Event-ID", equalTo("evt-1"))
                .withHeader("MCP-Protocol-Version", equalTo("2026-07-28")));
    }

    @Test
    void mcpDeleteForwardsSessionToRuntime() {
        String runtimePath = "/internal/v1/runtime/workspaces/" + wsId + "/mcp";
        wireMock.stubFor(delete(urlEqualTo(runtimePath))
                .willReturn(aResponse()
                        .withStatus(200)
                        .withHeader("Content-Type", "application/json")
                        .withBody("{\"jsonrpc\":\"2.0\",\"result\":{\"disconnected\":true}}")));

        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(token);
        headers.set("X-Workspace-Id", wsId);
        headers.set("mcp-session-id", "session-to-close");
        ResponseEntity<String> response = restTemplate.exchange(
                url("/api/v1/mcp"), HttpMethod.DELETE, new HttpEntity<>(headers), String.class);

        assertEquals(HttpStatus.OK, response.getStatusCode());
        assertTrue(response.getBody().contains("disconnected"));
        wireMock.verify(deleteRequestedFor(urlEqualTo(runtimePath))
                .withHeader("mcp-session-id", equalTo("session-to-close"))
                .withHeader("MCP-Protocol-Version", equalTo("2026-07-28")));
    }
}
