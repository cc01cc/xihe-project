package com.cc01cc.p.xihe.cp.crossmodule;

import static com.github.tomakehurst.wiremock.client.WireMock.aResponse;
import static com.github.tomakehurst.wiremock.client.WireMock.containing;
import static com.github.tomakehurst.wiremock.client.WireMock.post;
import static com.github.tomakehurst.wiremock.client.WireMock.postRequestedFor;
import static com.github.tomakehurst.wiremock.client.WireMock.urlEqualTo;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.cc01cc.p.xihe.cp.config.JwtTokenProvider;
import com.cc01cc.p.xihe.cp.entity.Session;
import com.cc01cc.p.xihe.cp.mcp.McpProxyCatalogService;
import com.cc01cc.p.xihe.cp.mcp.McpToolTimeoutService;
import com.cc01cc.p.xihe.cp.repository.SessionRepository;
import com.cc01cc.p.xihe.cp.service.WorkspaceService;
import com.fasterxml.jackson.databind.JsonNode;
import java.time.Duration;
import java.util.Map;
import java.util.UUID;
import org.awaitility.Awaitility;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

/**
 * PLAN-0583 M1/Z10：真实 Spring 上下文 + 真实 HTTP + H2 + WireMock（**不需要 Docker**）下的
 * 「映射 TTL 清空 → `tools/call` 未命中按工作区重建」链路。
 *
 * <p>为什么这里断言的是「名字被重建解析出来」而不是 200：Agent 来源的 `tools/call` 还必须通过
 * 持久化的 Session/Run/Invocation/ToolCall 门（{@code McpProxyController:731-738}），本测试不
 * 伪造那套账本。修复前的出口是 `400 UNKNOWN_TOOL`，修复后出口变成门禁 `403 FORBIDDEN`
 * ——再加上 WireMock 对 stdio 目录扇出次数的精确计数，即可唯一确定「名字经重建解析成功」。
 * 路由到 200 的完整链路由 CP 单测（`McpProxyTest` Z3/Z4）与 host E2E（M2）承担。
 */
class McpToolMapRebuildIntegrationTest extends AbstractWireMockTest {

    private static final String STDIO_SERVER = "e2e-stdio";

    @Autowired
    private JwtTokenProvider jwtTokenProvider;

    @Autowired
    private SessionRepository sessionRepository;

    @Autowired
    private WorkspaceService workspaceService;

    @Autowired
    private McpProxyCatalogService catalogService;

    @Autowired
    private McpToolTimeoutService toolTimeoutService;

    @DynamicPropertySource
    static void configureProperties(DynamicPropertyRegistry registry) {
        registry.add("cp.mcp.runtime-url", () -> "http://localhost:" + wireMock.port());
        // 决策 #5：TTL 覆盖只存在于测试/栈注入通道；默认值仍是 300s（M2 的默认 TTL 证据不用它）。
        registry.add("cp.mcp.toolmap.ttl-seconds", () -> "1");
    }

    private String wsId;
    private String userId;
    private String token;
    private String sessionId;

    @BeforeEach
    void setUp() {
        super.setUp();
        wireMock.resetAll();
        token = registerAndLogin();
        userId = jwtTokenProvider.getUserIdFromToken(token);
        wsId = workspaceService.findCurrentWorkspace(userId).orElseThrow().getId().toString();
        catalogService.replaceStdioConfigs(wsId, Map.of(STDIO_SERVER, objectMapper.createObjectNode()
                .put("command", "node")));
        Session session = new Session(wsId, userId, "PLAN-0583 tool map rebuild");
        sessionId = UUID.randomUUID().toString();
        session.setId(UUID.fromString(sessionId));
        sessionRepository.saveAndFlush(session);
        stubRuntime();
    }

    private void stubRuntime() {
        wireMock.stubFor(post(urlEqualTo("/internal/v1/runtime/workspaces/" + wsId + "/mcp"))
                .willReturn(aResponse()
                        .withStatus(200)
                        .withHeader("Content-Type", "application/json")
                        .withBody("{\"jsonrpc\":\"2.0\",\"result\":{\"tools\":"
                                + "[{\"name\":\"read_file\"}]},\"id\":1}")));
        wireMock.stubFor(post(urlEqualTo(stdioPath()))
                .withRequestBody(containing("\"method\":\"tools/list\""))
                .willReturn(aResponse()
                        .withStatus(200)
                        .withHeader("Content-Type", "application/json")
                        .withBody("{\"jsonrpc\":\"2.0\",\"result\":{\"tools\":"
                                + "[{\"name\":\"e2e_echo\",\"description\":\"Echo\"}]},\"id\":1}")));
        wireMock.stubFor(post(urlEqualTo(stdioPath()))
                .withRequestBody(containing("\"method\":\"tools/call\""))
                .willReturn(aResponse()
                        .withStatus(200)
                        .withHeader("Content-Type", "application/json")
                        .withBody("{\"jsonrpc\":\"2.0\",\"result\":{\"content\":"
                                + "[{\"type\":\"text\",\"text\":\"stdio-ok\"}]},\"id\":1}")));
    }

    private String stdioPath() {
        return "/internal/v1/runtime/workspaces/" + wsId + "/mcp/stdio/" + STDIO_SERVER;
    }

    private HttpEntity<String> userEntity(String body) {
        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.APPLICATION_JSON);
        headers.setBearerAuth(token);
        headers.set("X-Workspace-Id", wsId);
        return new HttpEntity<>(body, headers);
    }

    private HttpEntity<String> agentEntity(String body) {
        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.APPLICATION_JSON);
        headers.setBearerAuth("dev-token-not-secure");
        headers.set("X-Workspace-Id", wsId);
        headers.set("X-Session-Id", sessionId);
        return new HttpEntity<>(body, headers);
    }

    private static String toolsCall(String tool) {
        return "{\"jsonrpc\":\"2.0\",\"method\":\"tools/call\",\"id\":9,"
                + "\"params\":{\"name\":\"" + tool + "\",\"arguments\":{}}}";
    }

    /** 就绪探针：等真实的 TTL 清空（`budgetCoverage=partial` = 映射表为空）。 */
    private void awaitMappingClearedByTtl() {
        Awaitility.await().atMost(Duration.ofSeconds(15)).pollInterval(Duration.ofMillis(100))
                .until(() -> "partial".equals(
                        toolTimeoutService.toolTimeoutPayload(wsId, userId, Map.of()).get("budgetCoverage")));
    }

    @Test
    void toolsCallAfterTtlRebuildsStdioMappingInsteadOfUnknownTool() {
        ResponseEntity<String> list = restTemplate.postForEntity(url("/api/v1/mcp"),
                userEntity("{\"jsonrpc\":\"2.0\",\"method\":\"tools/list\",\"id\":1}"), String.class);
        assertEquals(HttpStatus.OK, list.getStatusCode());
        assertTrue(list.getBody().contains("e2e_echo"),
                "tools/list must publish the stdio tool, got: " + list.getBody());
        wireMock.verify(1, postRequestedFor(urlEqualTo(stdioPath()))
                .withRequestBody(containing("\"method\":\"tools/list\"")));

        awaitMappingClearedByTtl();

        ResponseEntity<String> call = restTemplate.postForEntity(url("/api/v1/mcp"),
                agentEntity(toolsCall("e2e_echo")), String.class);

        JsonNode problem = readProblem(call);
        assertNotEquals(HttpStatus.BAD_REQUEST.value(), call.getStatusCode().value(),
                "a stdio tool that is still installed must not degrade to UNKNOWN_TOOL: " + call.getBody());
        assertFalse("UNKNOWN_TOOL".equals(problem.path("code").asText()),
                "the rebuild must resolve the name before the error path: " + call.getBody());
        assertEquals("FORBIDDEN", problem.path("code").asText(),
                "expected the durable Agent tool-call gate to stop the dispatch after a successful rebuild: "
                        + call.getBody());

        // 唯一能区分「重建过」与「没重建过」的计数：stdio 目录被扇出恰好两次（首次 list + 重建）。
        wireMock.verify(2, postRequestedFor(urlEqualTo(stdioPath()))
                .withRequestBody(containing("\"method\":\"tools/list\"")));
        wireMock.verify(0, postRequestedFor(urlEqualTo(stdioPath()))
                .withRequestBody(containing("\"method\":\"tools/call\"")));
    }

    @Test
    void repeatedUnknownToolAfterTtlRebuildsOnlyOncePerMappingEpoch() {
        restTemplate.postForEntity(url("/api/v1/mcp"),
                userEntity("{\"jsonrpc\":\"2.0\",\"method\":\"tools/list\",\"id\":1}"), String.class);
        awaitMappingClearedByTtl();

        ResponseEntity<String> first = restTemplate.postForEntity(url("/api/v1/mcp"),
                agentEntity(toolsCall("ghost_tool")), String.class);
        ResponseEntity<String> second = restTemplate.postForEntity(url("/api/v1/mcp"),
                agentEntity(toolsCall("ghost_tool")), String.class);

        assertEquals(HttpStatus.BAD_REQUEST, first.getStatusCode());
        assertEquals("UNKNOWN_TOOL", readProblem(first).path("code").asText());
        assertEquals(HttpStatus.BAD_REQUEST, second.getStatusCode());
        assertEquals("UNKNOWN_TOOL", readProblem(second).path("code").asText());
        wireMock.verify(2, postRequestedFor(urlEqualTo(stdioPath()))
                .withRequestBody(containing("\"method\":\"tools/list\"")));
    }

    private JsonNode readProblem(ResponseEntity<String> response) {
        assertNotNull(response.getBody(), "Problem Details body must be present");
        try {
            return objectMapper.readTree(response.getBody());
        } catch (Exception e) {
            throw new AssertionError("response is not JSON: " + response.getBody(), e);
        }
    }
}
