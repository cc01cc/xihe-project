package com.cc01cc.p.xihe.cp.mcp;

import com.cc01cc.p.xihe.cp.config.CpApiException;
import com.cc01cc.p.xihe.cp.config.TenantContext;
import com.cc01cc.p.xihe.cp.runtime.RuntimeMcpSessionClient;
import com.cc01cc.p.xihe.cp.service.WorkspaceService;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.Mockito;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;

import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.when;

/**
 * PLAN-0366 T1.1/T0.3：`mcp/servers` 查询端点的公开契约
 * （字段映射 camelCase + 小写 state、错误表、鉴权）。
 */
class McpSessionStatusControllerTest {

    private WorkspaceService workspaceService;
    private RuntimeMcpSessionClient runtimeMcpSessionClient;
    private McpSessionStatusController controller;

    @BeforeEach
    void setUp() {
        workspaceService = Mockito.mock(WorkspaceService.class);
        runtimeMcpSessionClient = Mockito.mock(RuntimeMcpSessionClient.class);
        controller = new McpSessionStatusController(workspaceService, runtimeMcpSessionClient,
                new ObjectMapper());
        TenantContext.setUserId("user-1");
    }

    @AfterEach
    void tearDown() {
        TenantContext.clear();
    }

    private RuntimeMcpSessionClient.Result ok(String body) {
        return new RuntimeMcpSessionClient.Result(false, 200, body);
    }

    @Test
    void mapsRuntimeWireToPublicCamelCaseAndKeepsLowercaseState() {
        when(runtimeMcpSessionClient.fetchServers("ws-1")).thenReturn(ok(
                "{\"servers\":[{\"server_id\":\"fs\",\"state\":\"ready\",\"attempt\":0,"
                        + "\"last_error\":null,\"since_ms\":1758182400000,\"epoch\":3}],\"count\":1}"));

        ResponseEntity<?> response = controller.mcpServers("ws-1");

        assertEquals(HttpStatus.OK, response.getStatusCode());
        Map<?, ?> body = (Map<?, ?>) response.getBody();
        assertEquals(1, body.get("count"));
        List<?> servers = (List<?>) body.get("servers");
        assertEquals(1, servers.size());
        Map<?, ?> server = (Map<?, ?>) servers.get(0);
        assertEquals("fs", server.get("serverId"));
        assertEquals("ready", server.get("state"));
        assertEquals(0, server.get("attempt"));
        assertNull(server.get("lastError"));
        assertEquals(1758182400000L, server.get("sinceMs"));
        assertEquals(3L, server.get("epoch"));
        assertFalse(server.containsKey("server_id"), "wire key must not leak");
        assertFalse(server.containsKey("last_error"));
        assertFalse(server.containsKey("since_ms"));
    }

    @Test
    void keepsFailureReasonAndRestartingLiteral() {
        when(runtimeMcpSessionClient.fetchServers("ws-1")).thenReturn(ok(
                "{\"servers\":[{\"server_id\":\"search\",\"state\":\"restarting\",\"attempt\":2,"
                        + "\"last_error\":\"spawn ENOENT\",\"since_ms\":1,\"epoch\":0}],\"count\":1}"));

        Map<?, ?> body = (Map<?, ?>) controller.mcpServers("ws-1").getBody();
        Map<?, ?> server = (Map<?, ?>) ((List<?>) body.get("servers")).get(0);
        assertEquals("restarting", server.get("state"));
        assertEquals(2, server.get("attempt"));
        assertEquals("spawn ENOENT", server.get("lastError"));
    }

    @Test
    void passesThroughWhitelistedLifecycleErrors() {
        when(runtimeMcpSessionClient.fetchServers("ws-1"))
                .thenReturn(new RuntimeMcpSessionClient.Result(false, 404,
                        "{\"code\":\"WORKSPACE_NOT_FOUND\"}"));
        ResponseEntity<?> notFound = controller.mcpServers("ws-1");
        assertEquals(HttpStatus.NOT_FOUND, notFound.getStatusCode());
        assertEquals("WORKSPACE_NOT_FOUND", ((Map<?, ?>) notFound.getBody()).get("code"));

        when(runtimeMcpSessionClient.fetchServers("ws-1"))
                .thenReturn(new RuntimeMcpSessionClient.Result(false, 409,
                        "{\"code\":\"WORKSPACE_DESTROYING\"}"));
        ResponseEntity<?> destroying = controller.mcpServers("ws-1");
        assertEquals(HttpStatus.CONFLICT, destroying.getStatusCode());
        assertEquals("WORKSPACE_DESTROYING", ((Map<?, ?>) destroying.getBody()).get("code"));

        when(runtimeMcpSessionClient.fetchServers("ws-1"))
                .thenReturn(new RuntimeMcpSessionClient.Result(false, 409,
                        "{\"code\":\"WORKSPACE_BUSY\"}"));
        assertEquals(HttpStatus.CONFLICT, controller.mcpServers("ws-1").getStatusCode());

        when(runtimeMcpSessionClient.fetchServers("ws-1"))
                .thenReturn(new RuntimeMcpSessionClient.Result(false, 503,
                        "{\"code\":\"WORKSPACE_MATERIALIZATION_FAILED\"}"));
        ResponseEntity<?> materializing = controller.mcpServers("ws-1");
        assertEquals(HttpStatus.SERVICE_UNAVAILABLE, materializing.getStatusCode());
        assertEquals("WORKSPACE_MATERIALIZATION_FAILED",
                ((Map<?, ?>) materializing.getBody()).get("code"));
    }

    @Test
    void foldsUnknownHttpErrorsAndUnparseableBodiesTo502() {
        when(runtimeMcpSessionClient.fetchServers("ws-1"))
                .thenReturn(new RuntimeMcpSessionClient.Result(false, 500, "{\"code\":\"RUNTIME_ERROR\"}"));
        assertRuntimeUnavailable(controller.mcpServers("ws-1"));

        when(runtimeMcpSessionClient.fetchServers("ws-1"))
                .thenReturn(new RuntimeMcpSessionClient.Result(false, 200, "not-json"));
        assertRuntimeUnavailable(controller.mcpServers("ws-1"));

        when(runtimeMcpSessionClient.fetchServers("ws-1")).thenReturn(
                new RuntimeMcpSessionClient.Result(true, 0, null));
        assertRuntimeUnavailable(controller.mcpServers("ws-1"));
    }

    @Test
    void hidesInaccessibleWorkspaceAs404WithoutCallingRuntime() {
        when(workspaceService.requireAccessibleWorkspace(eq("ws-1"), anyString()))
                .thenThrow(new CpApiException(HttpStatus.NOT_FOUND, "WORKSPACE_NOT_FOUND",
                        "Workspace not found"));

        ResponseEntity<?> response = controller.mcpServers("ws-1");

        assertEquals(HttpStatus.NOT_FOUND, response.getStatusCode());
        assertEquals("WORKSPACE_NOT_FOUND", ((Map<?, ?>) response.getBody()).get("code"));
        Mockito.verifyNoInteractions(runtimeMcpSessionClient);
    }

    @Test
    void rejectsMissingAuthenticationContext() {
        TenantContext.clear();
        ResponseEntity<?> response = controller.mcpServers("ws-1");
        assertEquals(HttpStatus.UNAUTHORIZED, response.getStatusCode());
        assertEquals("AUTHORIZATION_REQUIRED", ((Map<?, ?>) response.getBody()).get("code"));
    }

    private static void assertRuntimeUnavailable(ResponseEntity<?> response) {
        assertEquals(HttpStatus.BAD_GATEWAY, response.getStatusCode());
        assertEquals("RUNTIME_UNAVAILABLE", ((Map<?, ?>) response.getBody()).get("code"));
    }
}
