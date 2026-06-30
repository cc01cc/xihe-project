package com.cc01cc.p.xihe.cp.crossmodule;

import static com.github.tomakehurst.wiremock.client.WireMock.*;
import static org.junit.jupiter.api.Assertions.*;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.http.*;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import java.util.UUID;

class RuntimeMcpIntegrationTest extends AbstractWireMockTest {

    @DynamicPropertySource
    static void configureProperties(DynamicPropertyRegistry registry) {
        registry.add("cp.mcp.runtime-base-url", () -> "http://localhost:" + wireMock.port());
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
        String runtimePath = "/workspace/" + wsId + "/mcp";

        wireMock.stubFor(post(urlPathMatching("/workspace/.*/mcp"))
                .willReturn(aResponse()
                        .withStatus(200)
                        .withHeader("Content-Type", "application/json")
                        .withBody("{\"jsonrpc\":\"2.0\",\"result\":{\"tools\":[]},\"id\":1}")));

        ResponseEntity<String> response = restTemplate.postForEntity(
                url("/mcp"), mcpEntity(TOOLS_LIST_BODY), String.class);

        assertEquals(HttpStatus.OK, response.getStatusCode());

        wireMock.verify(postRequestedFor(urlEqualTo(runtimePath))
                .withHeader("Content-Type", containing("application/json"))
                .withRequestBody(containing("tools/list")));
    }

    @Test
    void mcpToolsListForwardsSessionIdHeader() {
        String runtimePath = "/workspace/" + wsId + "/mcp";

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
                url("/mcp"), entity, String.class);

        assertEquals(HttpStatus.OK, response.getStatusCode());

        wireMock.verify(postRequestedFor(urlEqualTo(runtimePath))
                .withHeader("mcp-session-id", containing("test-session-value")));
    }

    @Test
    void mcpReturns400WhenMissingWorkspaceId() {
        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.APPLICATION_JSON);
        headers.setBearerAuth(token);
        HttpEntity<String> entity = new HttpEntity<>(TOOLS_LIST_BODY, headers);

        ResponseEntity<String> response = restTemplate.postForEntity(
                url("/mcp"), entity, String.class);

        assertEquals(HttpStatus.BAD_REQUEST, response.getStatusCode());
    }

    @Test
    void mcpToolsListHandlesRuntimeErrorGracefully() {
        wireMock.stubFor(post(urlPathMatching("/workspace/.*/mcp"))
                .willReturn(aResponse().withStatus(500)));

        ResponseEntity<String> response = restTemplate.postForEntity(
                url("/mcp"), mcpEntity(TOOLS_LIST_BODY), String.class);

        assertEquals(HttpStatus.OK, response.getStatusCode());
        assertTrue(response.getBody().contains("\"tools\""));

        wireMock.verify(postRequestedFor(urlPathMatching("/workspace/.*/mcp")));
    }
}
