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

/**
 * 逻辑 MCP 的**无会话**契约（PLAN-0308 M2 决策 #34）。
 *
 * <p>此前该测试断言的是「CP 签发/回传签名会话 id、按映射转发 mcp-session-id、
 * GET/DELETE 原样转发」——2026-07-28（SEP-2567）去会话化与本 PLAN 的实测根因
 * （Agent 侧 SDK 只能声明 2025-11-25 → 透传后 Runtime 走有会话/可恢复路径 →
 * 同一响应在 POST 与 GET 两通道各投递一次导致工具调用挂死）共同决定了新姿态：
 * 逻辑 MCP 固定按无会话世代服务，只谈 JSON，不签发会话，不提供 GET/DELETE。
 */
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
            {"jsonrpc":"2.0","method":"initialize","params":{"protocolVersion":"2025-11-25"},"id":1}
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

    /** Runtime 即使回传 mcp-session-id，CP 也不得再签发/回传给调用方（决策 #34）。 */
    private void initializeMcpWithoutSessions() {
        String runtimePath = "/internal/v1/runtime/workspaces/" + wsId + "/mcp";
        wireMock.stubFor(post(urlEqualTo(runtimePath))
                .withRequestBody(containing("\"method\":\"initialize\""))
                .willReturn(aResponse()
                        .withStatus(200)
                        .withHeader("Content-Type", "application/json")
                        .withHeader("mcp-session-id", "runtime-session-" + UUID.randomUUID())
                        .withBody("{\"jsonrpc\":\"2.0\",\"result\":{\"protocolVersion\":\"2026-07-28\",\"capabilities\":{}},\"id\":1}")));

        ResponseEntity<String> response = restTemplate.postForEntity(
                url("/api/v1/mcp"), mcpEntity(INITIALIZE_BODY), String.class);
        assertEquals(HttpStatus.OK, response.getStatusCode());
        assertNull(response.getHeaders().getFirst("mcp-session-id"),
                "stateless logical MCP must not issue a protocol session id");
    }

    @Test
    void mcpToolsListForwardsToRuntime() {
        String runtimePath = "/internal/v1/runtime/workspaces/" + wsId + "/mcp";
        initializeMcpWithoutSessions();

        wireMock.stubFor(post(urlEqualTo(runtimePath))
                .withRequestBody(containing("\"method\":\"tools/list\""))
                .willReturn(aResponse()
                        .withStatus(200)
                        .withHeader("Content-Type", "application/json")
                        .withBody("{\"jsonrpc\":\"2.0\",\"result\":{\"tools\":["
                                + "{\"name\":\"apply_patch\",\"description\":\"Apply patch\","
                                + "\"inputSchema\":{\"type\":\"object\",\"properties\":{"
                                + "\"patches\":{\"type\":\"array\"}}}},"
                                + "{\"name\":\"write_file\"}]},\"id\":1}")));

        ResponseEntity<String> response = restTemplate.postForEntity(
                url("/api/v1/mcp"), mcpEntity(TOOLS_LIST_BODY), String.class);

        assertEquals(HttpStatus.OK, response.getStatusCode());
        assertTrue(response.getBody().contains("\"name\":\"apply_patch\""),
                "Gateway tools/list must carry the public apply_patch tool");
        assertTrue(response.getBody().contains("\"patches\":{\"type\":\"array\"}"),
                "apply_patch wire schema must remain structured");
        assertFalse(response.getBody().contains("create_snapshot"),
                "create_snapshot must remain absent from Gateway tools/list");
        assertFalse(response.getBody().contains("revert_snapshot"),
                "revert_snapshot must remain absent from Gateway tools/list");
        assertFalse(response.getBody().contains("revert_checkpoint"),
                "revert_checkpoint is a CP ledger value, not a Gateway tool");

        wireMock.verify(postRequestedFor(urlEqualTo(runtimePath))
                .withHeader("Content-Type", containing("application/json"))
                .withRequestBody(containing("tools/list")));
    }

    /**
     * 客户端声明旧版本 + SSE Accept 时：CP 仍按**固定版本**转发（上游必须收到规范的
     * 双 Accept——rmcp 对只声明 JSON 的请求回 406），但不再转发会话与可恢复相关头。
     */
    @Test
    void mcpForwardPinsStatelessProtocolVersionAndDropsSessionHeaders() {
        String runtimePath = "/internal/v1/runtime/workspaces/" + wsId + "/mcp";
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
        headers.set("MCP-Protocol-Version", "2025-11-25");
        headers.set("Accept", "application/json, text/event-stream");
        headers.set("Last-Event-ID", "evt-1");

        ResponseEntity<String> response = restTemplate.postForEntity(
                url("/api/v1/mcp"), new HttpEntity<>(TOOLS_LIST_BODY, headers), String.class);
        assertEquals(HttpStatus.OK, response.getStatusCode());

        wireMock.verify(postRequestedFor(urlEqualTo(runtimePath))
                .withHeader("Accept", equalTo("application/json, text/event-stream"))
                .withHeader("MCP-Protocol-Version", equalTo("2026-07-28")));
        wireMock.verify(0, postRequestedFor(urlEqualTo(runtimePath))
                .withHeader("mcp-session-id", matching(".+")));
        wireMock.verify(0, postRequestedFor(urlEqualTo(runtimePath))
                .withHeader("Last-Event-ID", matching(".+")));
    }

    /**
     * 决策 #34②：Runtime 以 SSE 帧应答时，CP 在下游解包为纯 JSON
     * （调用方不接触 SSE 帧、Last-Event-ID 与事件重放语义）。
     */
    @Test
    void mcpForwardUnwrapsSseResponseToJson() {
        String runtimePath = "/internal/v1/runtime/workspaces/" + wsId + "/mcp";
        wireMock.stubFor(post(urlEqualTo(runtimePath))
                .withRequestBody(containing("\"method\":\"tools/list\""))
                .willReturn(aResponse()
                        .withStatus(200)
                        .withHeader("Content-Type", "text/event-stream")
                        .withBody("event: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"tools\":[]}}\n\n")));

        ResponseEntity<String> response = restTemplate.postForEntity(
                url("/api/v1/mcp"), mcpEntity(TOOLS_LIST_BODY), String.class);

        assertEquals(HttpStatus.OK, response.getStatusCode());
        assertEquals(MediaType.APPLICATION_JSON_VALUE, response.getHeaders().getFirst("Content-Type"));
        // 合并响应回显调用方 id（id=1），并携带 2026-07-28 modern 结果必填字段。
        assertEquals(
                "{\"jsonrpc\":\"2.0\",\"result\":{\"tools\":[],\"resultType\":\"complete\","
                        + "\"cacheScope\":\"private\",\"ttlMs\":0},\"id\":1}",
                response.getBody(),
                "SSE framing must be unwrapped before returning to the caller");
        assertNull(response.getHeaders().getFirst("mcp-session-id"));
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
        initializeMcpWithoutSessions();
        wireMock.stubFor(post(urlEqualTo(runtimePath))
                .withRequestBody(containing("\"method\":\"tools/list\""))
                .willReturn(aResponse().withStatus(500)));

        ResponseEntity<String> response = restTemplate.postForEntity(
                url("/api/v1/mcp"), mcpEntity(TOOLS_LIST_BODY), String.class);

        assertEquals(HttpStatus.OK, response.getStatusCode());
        assertTrue(response.getBody().contains("\"tools\""));

        wireMock.verify(postRequestedFor(urlEqualTo(runtimePath))
                .withRequestBody(containing("\"method\":\"tools/list\"")));
    }

    /** 决策 #34：无会话 ⇒ 不提供服务端主动推送通道（不再转发 GET）。 */
    @Test
    void mcpGetIsRejectedWithoutForwarding() {
        String runtimePath = "/internal/v1/runtime/workspaces/" + wsId + "/mcp";
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(token);
        headers.set("X-Workspace-Id", wsId);

        ResponseEntity<String> response = restTemplate.exchange(
                url("/api/v1/mcp"), HttpMethod.GET, new HttpEntity<>(headers), String.class);

        assertEquals(HttpStatus.METHOD_NOT_ALLOWED, response.getStatusCode());
        assertTrue(response.getBody().contains("MCP_STREAM_NOT_SUPPORTED"));
        wireMock.verify(0, getRequestedFor(urlEqualTo(runtimePath)));
    }

    /** 决策 #34：无会话 ⇒ 没有可终止的协议会话（不再转发 DELETE）。 */
    @Test
    void mcpDeleteIsRejectedWithoutForwarding() {
        String runtimePath = "/internal/v1/runtime/workspaces/" + wsId + "/mcp";
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(token);
        headers.set("X-Workspace-Id", wsId);

        ResponseEntity<String> response = restTemplate.exchange(
                url("/api/v1/mcp"), HttpMethod.DELETE, new HttpEntity<>(headers), String.class);

        assertEquals(HttpStatus.METHOD_NOT_ALLOWED, response.getStatusCode());
        assertTrue(response.getBody().contains("MCP_SESSION_NOT_SUPPORTED"));
        wireMock.verify(0, deleteRequestedFor(urlEqualTo(runtimePath)));
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
        assertNull(response.getHeaders().getFirst("mcp-session-id"));
        wireMock.verify(postRequestedFor(urlEqualTo(runtimePath))
                .withHeader("Authorization", equalTo("Bearer dev-token-not-secure")));

        wireMock.stubFor(post(urlEqualTo(runtimePath))
                .withRequestBody(containing("\"method\":\"tools/list\""))
                .willReturn(aResponse()
                        .withStatus(200)
                        .withHeader("Content-Type", "application/json")
                        .withBody("{\"jsonrpc\":\"2.0\",\"result\":{\"tools\":[]},\"id\":1}")));
        HttpHeaders followUpHeaders = new HttpHeaders();
        followUpHeaders.setContentType(MediaType.APPLICATION_JSON);
        followUpHeaders.setBearerAuth("dev-token-not-secure");
        followUpHeaders.set("X-Workspace-Id", wsId);
        ResponseEntity<String> followUp = restTemplate.postForEntity(
                url("/api/v1/mcp"), new HttpEntity<>(TOOLS_LIST_BODY, followUpHeaders), String.class);
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

    /** 无法验证的会话 id 仍然拒绝（安全语义不变，即使 CP 自己不再签发）。 */
    @Test
    void mcpRejectsUnverifiableSessionId() {
        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.APPLICATION_JSON);
        headers.setBearerAuth(token);
        headers.set("X-Workspace-Id", wsId);
        headers.set("mcp-session-id", "not-a-signed-session");

        ResponseEntity<String> response = restTemplate.postForEntity(
                url("/api/v1/mcp"), new HttpEntity<>(TOOLS_LIST_BODY, headers), String.class);

        assertEquals(HttpStatus.FORBIDDEN, response.getStatusCode());
    }
}
